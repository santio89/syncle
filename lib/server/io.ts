/**
 * Socket.IO event wiring + in-memory room registry for Syncle multiplayer.
 *
 * Loaded by the custom Next.js server (`server.ts`) and never bundled into
 * the browser. Imports `lib/multi/protocol` purely for shared types so the
 * wire format can't drift between client and server.
 *
 * Single-process, in-memory store. Trade-off:
 *   - Pros: zero infra, sub-millisecond room ops, easy to reason about.
 *   - Cons: rooms vanish on a server restart; no horizontal scale.
 *   - Mitigations: (a) Render free tier restarts only on deploy/idle-spin
 *     and we already have client reconnect, so users see "session expired";
 *     (b) when we outgrow this, swap the Map<> backing store for Redis.
 */

import { randomUUID } from "node:crypto";
import type { Server as IOServer, Socket } from "socket.io";

import type { ChartMode } from "@/lib/game/chart";
import {
  AckResult,
  CatalogItem,
  CHAT_RATE_LIMIT,
  CHAT_RATE_WINDOW_MS,
  ChatMessage,
  ClientToServerEvents,
  FinalStats,
  LiveScore,
  MATCH_COUNTDOWN_LEAD_MS,
  MATCH_MAX_DURATION_FALLBACK_MS,
  MATCH_RESULTS_GRACE_MS,
  MAX_CHAT_HISTORY,
  MAX_PLAYERS_PER_ROOM,
  NoticeKind,
  PlayerSnapshot,
  PublicRoomEntry,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  RoomPhase,
  RoomSnapshot,
  RoomVisibility,
  ScoreboardEntry,
  ServerToClientEvents,
  SongRef,
  Standing,
  isValidRoomCode,
  sanitizeChatText,
  sanitizeName,
  sanitizeRoomName,
} from "@/lib/multi/protocol";
import { fetchCatalog } from "./catalog";

/* -------------------------------------------------------------------------- */
/* Tunables                                                                   */
/* -------------------------------------------------------------------------- */

/** How long a disconnected player keeps their slot before eviction. */
const PLAYER_GRACE_MS = 60_000;
/** How long a fully-empty room sticks around for refresh-rejoin. */
const EMPTY_ROOM_TTL_MS = 10 * 60_000;
/**
 * Hard cap on how long a room can sit without ANY meaningful activity
 * (chat, song change, ready toggle, score update, etc.) before the
 * server force-closes it. Prevents abandoned-but-non-empty rooms from
 * hanging around in the public browser forever and provides a passive
 * anti-spam ceiling on top of the host-leaves-closes-lobby rule below.
 *
 * "Activity" is bumped centrally from `emitSnapshot` (covers every
 * state change) and `emitScoreboard` (covers in-match score churn that
 * doesn't necessarily re-snapshot), so any real interaction in the
 * room resets the clock.
 */
const INACTIVITY_TTL_MS = 30 * 60_000;
/** Max wait for everyone to call `client:ready` after host hits start. */
const LOADING_DEADLINE_MS = 30_000;
/**
 * Grace between "everyone ready" and the wall-clock t0 for audio.
 * Sourced from the shared protocol constant so the server's
 * `phase:countdown` → `phase:playing` window matches exactly the
 * length of the client's "3 / 2 / 1" overlay (3 s) plus the silent
 * lead-in runway (2 s) — total 5 s. If you change the timing here,
 * change `MATCH_OVERLAY_MS` / `MATCH_LEAD_IN_MS` in
 * `lib/multi/protocol.ts` instead so client + server stay in lockstep.
 */
const COUNTDOWN_LEAD_MS = MATCH_COUNTDOWN_LEAD_MS;
/** Score broadcast cadence (ms). 200 ms = 5 Hz, plenty smooth for a sidebar. */
const SCOREBOARD_TICK_MS = 200;

/* -------------------------------------------------------------------------- */
/* Internal types                                                             */
/* -------------------------------------------------------------------------- */

interface InternalPlayer {
  id: string;
  socketId: string | null;
  name: string;
  isHost: boolean;
  joinedAt: number;
  ready: boolean;
  /** Lobby-level "ready to play" flag — see PlayerSnapshot doc. */
  lobbyReady: boolean;
  /** Host-set chat silence flag. */
  muted: boolean;
  live: LiveScore;
  final: FinalStats | null;
  postChoice: "stay" | "leave" | null;
  graceTimer: NodeJS.Timeout | null;
  /**
   * Sliding window of recent chat send timestamps (ms). Used to enforce
   * CHAT_RATE_LIMIT per CHAT_RATE_WINDOW_MS without allocating a new
   * structure per message — we just push + filter on every send.
   */
  chatTimestamps: number[];
}

interface InternalRoom {
  code: string;
  name: string;
  visibility: RoomVisibility;
  createdAt: number;
  hostId: string;
  phase: RoomPhase;
  players: Map<string, InternalPlayer>;
  selectedSong: SongRef | null;
  selectedMode: ChartMode | null;
  startsAt: number | null;
  songStartedAt: number | null;
  /** Rolling chat backlog, oldest first, capped at MAX_CHAT_HISTORY. */
  chat: ChatMessage[];
  /** Monotonically-incrementing chat message id (room-scoped). */
  nextChatId: number;
  catalog: CatalogItem[] | null;
  catalogFetchedAt: number | null;
  emptyTtlTimer: NodeJS.Timeout | null;
  loadingTimer: NodeJS.Timeout | null;
  /**
   * Sliding inactivity timer. Set on room creation and reset on every
   * activity bump (any snapshot or scoreboard fan-out). Fires
   * `closeRoom(... "inactivity")` when nothing has happened in the room
   * for `INACTIVITY_TTL_MS`. Cleared during room close + re-armed by
   * `bumpActivity` on every meaningful interaction.
   */
  inactivityTimer: NodeJS.Timeout | null;
  /** Wall-clock of the most recent activity bump (debug / future use). */
  lastActivityAt: number;
  /**
   * Wall-clock safety net for the "playing" phase. Scheduled when the
   * server flips to `phase === "playing"` to fire at
   * `songStartedAt + songDurationMs + MATCH_RESULTS_GRACE_MS`. If the
   * room is still in "playing" by then, `forceTransitionToResults`
   * synthesises a `final` from each unfinished player's last `live`
   * snapshot and flips the room to "results" so the results screen
   * ALWAYS shows up — even if a `player:finished` packet from one of
   * the clients was lost, the chart never loaded for them, their tab
   * froze, etc. Without this timer the room would otherwise stay in
   * "playing" forever and nobody (not even players who cleanly
   * finished) would ever see their final standings.
   *
   * Cleared in every transition out of "playing" (results, lobby).
   */
  matchSafetyTimer: NodeJS.Timeout | null;
}

type Sock = Socket<ClientToServerEvents, ServerToClientEvents>;
type IO = IOServer<ClientToServerEvents, ServerToClientEvents>;

class RoomError extends Error {
  constructor(public errCode: string, message: string) {
    super(message);
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function emptyLive(): LiveScore {
  return {
    score: 0,
    combo: 0,
    maxCombo: 0,
    accuracy: 100,
    notesPlayed: 0,
    totalNotes: 0,
    hits: { perfect: 0, great: 0, good: 0, miss: 0 },
    // Server-side mirror of the client's initial rock meter — starts
    // empty so the lobby/loading snapshot doesn't broadcast a fake 100%
    // bar before the player has hit a single note. Live updates via
    // `player:stats` overwrite this almost immediately once the chart
    // loads.
    health: 0,
    finished: false,
  };
}

function clampNum(v: unknown, min: number, max: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : 0;
  return Math.max(min, Math.min(max, n));
}

function randomCode(): string {
  let out = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    out += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                   */
/* -------------------------------------------------------------------------- */

class RoomRegistry {
  private rooms = new Map<string, InternalRoom>();
  /** socket.id → which (room, session) it represents. */
  private socketIndex = new Map<string, { code: string; sessionId: string }>();
  /** code → pending scoreboard fan-out timer (coalesces high-rate updates). */
  private pendingScoreboard = new Set<string>();

  constructor(private io: IO) {}

  /* ---- broadcast helpers ---- */

  emitSnapshot(code: string): void {
    const room = this.rooms.get(code);
    if (!room) return;
    this.bumpActivity(room);
    this.io.to(`room:${code}`).emit("room:snapshot", this.snapshotOf(room));
  }

  /**
   * Reset the room's inactivity timer. Called from every fan-out helper
   * (`emitSnapshot`, `emitScoreboard`) so any real interaction — host
   * picks a song, a player marks ready, a score update streams in,
   * someone joins or leaves — keeps the room alive. A room that goes
   * `INACTIVITY_TTL_MS` without a bump is force-closed.
   */
  private bumpActivity(room: InternalRoom): void {
    room.lastActivityAt = Date.now();
    if (room.inactivityTimer) clearTimeout(room.inactivityTimer);
    room.inactivityTimer = setTimeout(() => {
      // Re-check liveness: if the room was already removed (empty TTL
      // beat us to it) the lookup is a no-op, but explicit guard keeps
      // the close path short-circuited.
      if (!this.rooms.has(room.code)) return;
      this.closeRoom(room, "Room closed due to inactivity");
    }, INACTIVITY_TTL_MS);
  }

  emitNotice(code: string, kind: NoticeKind, text: string): void {
    this.io.to(`room:${code}`).emit("room:notice", { kind, text });
  }

  emitScoreboard(code: string): void {
    const room = this.rooms.get(code);
    if (!room) return;
    this.bumpActivity(room);
    const entries: ScoreboardEntry[] = [];
    for (const p of room.players.values()) {
      entries.push({
        id: p.id,
        name: p.name,
        score: p.live.score,
        combo: p.live.combo,
        accuracy: p.live.accuracy,
        online: p.socketId !== null,
        finished: p.live.finished,
      });
    }
    entries.sort((a, b) => b.score - a.score);
    this.io.to(`room:${code}`).emit("room:scoreboard", entries);
  }

  scheduleScoreboard(code: string): void {
    if (this.pendingScoreboard.has(code)) return;
    this.pendingScoreboard.add(code);
    setTimeout(() => {
      this.pendingScoreboard.delete(code);
      this.emitScoreboard(code);
    }, SCOREBOARD_TICK_MS);
  }

  /* ---- snapshot ---- */

  snapshotOf(room: InternalRoom): RoomSnapshot {
    const players: PlayerSnapshot[] = [];
    for (const p of room.players.values()) {
      players.push({
        id: p.id,
        name: p.name,
        isHost: p.isHost,
        online: p.socketId !== null,
        joinedAt: p.joinedAt,
        ready: p.ready,
        lobbyReady: p.lobbyReady,
        muted: p.muted,
        live: p.live,
        final: p.final,
        postChoice: p.postChoice,
      });
    }
    players.sort((a, b) => a.joinedAt - b.joinedAt);
    return {
      code: room.code,
      name: room.name,
      visibility: room.visibility,
      hostId: room.hostId,
      phase: room.phase,
      selectedSong: room.selectedSong,
      // Carry the active difficulty on every snapshot so reconnecting
      // clients can re-derive which chart to fetch without having to
      // re-receive the one-shot `phase:loading` event they missed.
      selectedMode: room.selectedMode,
      startsAt: room.startsAt,
      songStartedAt: room.songStartedAt,
      players,
      chat: room.chat,
    };
  }

  /**
   * Compact public-room representation for the browser listing. Skipped
   * when the room is private or empty (an empty room ID is just stale
   * cruft from someone bouncing).
   */
  publicEntryOf(room: InternalRoom): PublicRoomEntry | null {
    if (room.visibility !== "public") return null;
    if (room.players.size === 0) return null;
    const host = room.players.get(room.hostId);
    return {
      code: room.code,
      name: room.name,
      hostName: host?.name ?? "—",
      playerCount: room.players.size,
      maxPlayers: MAX_PLAYERS_PER_ROOM,
      phase: room.phase,
      selectedSong: room.selectedSong
        ? `${room.selectedSong.artist} — ${room.selectedSong.title}`
        : null,
      createdAt: room.createdAt,
    };
  }

  listPublicRooms(): PublicRoomEntry[] {
    const out: PublicRoomEntry[] = [];
    for (const room of this.rooms.values()) {
      const entry = this.publicEntryOf(room);
      if (entry) out.push(entry);
    }
    // Most-populated first, then youngest first as a tiebreaker so a
    // freshly-spun-up "0 players" room ends up at the bottom even
    // briefly. The publicEntryOf filter already excludes empty rooms,
    // but the sort still helps with one-player rooms vs five-player
    // rooms in the same browser window.
    out.sort(
      (a, b) =>
        b.playerCount - a.playerCount || b.createdAt - a.createdAt,
    );
    return out;
  }

  standingsOf(room: InternalRoom): { standings: Standing[]; winnerId: string } {
    const arr: Standing[] = [];
    for (const p of room.players.values()) {
      const f = p.final;
      arr.push({
        id: p.id,
        name: p.name,
        score: f?.score ?? p.live.score,
        accuracy: f?.accuracy ?? p.live.accuracy,
        maxCombo: f?.maxCombo ?? p.live.maxCombo,
        rank: 0,
        online: p.socketId !== null,
      });
    }
    arr.sort((a, b) => b.score - a.score);
    arr.forEach((s, i) => (s.rank = i + 1));
    return { standings: arr, winnerId: arr[0]?.id ?? "" };
  }

  /* ---- room lifecycle ---- */

  generateCode(): string {
    for (let i = 0; i < 50; i++) {
      const c = randomCode();
      if (!this.rooms.has(c)) return c;
    }
    throw new RoomError("CODE_EXHAUSTED", "Could not allocate a fresh room code");
  }

  createRoom(
    socketId: string,
    displayName: string,
    roomName: string,
    visibility: RoomVisibility,
  ): { code: string; sessionId: string } {
    // Belt-and-braces: a socket is only ever supposed to occupy ONE
    // (room, session) slot at a time. If this socket is already linked
    // to another room (e.g. the user clicked "Create" without first
    // navigating away from a previous room), evict that slot first so
    // the prior room doesn't end up with an orphaned, perpetually-
    // "online" ghost player. Without this, repeated create/join
    // bouncing leaves stacks of zombie slots in old rooms — the bug
    // visible in the screenshot where "santi" appeared three times in
    // the same room.
    this.releaseSocketSlot(socketId);
    const code = this.generateCode();
    const sessionId = randomUUID();
    const room: InternalRoom = {
      code,
      name: roomName,
      visibility,
      createdAt: Date.now(),
      hostId: sessionId,
      phase: "lobby",
      players: new Map(),
      selectedSong: null,
      selectedMode: null,
      startsAt: null,
      songStartedAt: null,
      chat: [],
      nextChatId: 1,
      catalog: null,
      catalogFetchedAt: null,
      emptyTtlTimer: null,
      loadingTimer: null,
      matchSafetyTimer: null,
      inactivityTimer: null,
      lastActivityAt: Date.now(),
    };
    room.players.set(sessionId, {
      id: sessionId,
      socketId,
      name: displayName,
      isHost: true,
      joinedAt: Date.now(),
      ready: false,
      lobbyReady: false,
      muted: false,
      live: emptyLive(),
      final: null,
      postChoice: null,
      graceTimer: null,
      chatTimestamps: [],
    });
    this.rooms.set(code, room);
    this.socketIndex.set(socketId, { code, sessionId });
    return { code, sessionId };
  }

  joinRoom(
    code: string,
    socketId: string,
    name: string,
  ): { sessionId: string } {
    const room = this.rooms.get(code);
    if (!room) throw new RoomError("ROOM_NOT_FOUND", `No room "${code}"`);
    if (room.players.size >= MAX_PLAYERS_PER_ROOM) {
      throw new RoomError("ROOM_FULL", `Room ${code} is full`);
    }
    // Same anti-zombie precaution as createRoom: free any prior slot
    // this socket was holding before claiming a fresh one. Crucially
    // this also handles the "joined the same room twice" case — a
    // stale player from a previous join attempt with this exact socket
    // gets evicted before we add a brand-new player, instead of
    // accumulating duplicates.
    this.releaseSocketSlot(socketId);
    if (room.emptyTtlTimer) {
      clearTimeout(room.emptyTtlTimer);
      room.emptyTtlTimer = null;
    }
    const sessionId = randomUUID();
    room.players.set(sessionId, {
      id: sessionId,
      socketId,
      name,
      isHost: false,
      joinedAt: Date.now(),
      ready: false,
      lobbyReady: false,
      muted: false,
      live: emptyLive(),
      final: null,
      postChoice: null,
      graceTimer: null,
      chatTimestamps: [],
    });
    this.socketIndex.set(socketId, { code, sessionId });
    return { sessionId };
  }

  rejoin(code: string, sessionId: string, socketId: string): InternalPlayer {
    const room = this.rooms.get(code);
    if (!room) throw new RoomError("ROOM_NOT_FOUND", "Room is gone");
    const p = room.players.get(sessionId);
    if (!p) {
      throw new RoomError(
        "SESSION_GONE",
        "Your seat was reclaimed — rejoin as a new player",
      );
    }
    // If this same socket was already pointed at a DIFFERENT slot
    // (different room, or a different session in this room), free
    // that slot first. Without this a quick reconnect-with-stale-
    // session followed by a manual rejoin can leave the prior session
    // sitting in a different room as an orphan.
    const prior = this.socketIndex.get(socketId);
    if (prior && (prior.code !== code || prior.sessionId !== sessionId)) {
      this.releaseSocketSlot(socketId);
    }
    if (p.graceTimer) {
      clearTimeout(p.graceTimer);
      p.graceTimer = null;
    }
    // If some OTHER live socket is currently bound to this seat (e.g.
    // a duplicate tab racing to rejoin with the same sessionId), drop
    // that mapping so the new socket cleanly owns the seat. We do
    // *not* disconnect the old socket — Socket.IO will emit to
    // whichever socket is currently in the room channel, and the new
    // socket re-joins below.
    if (p.socketId && p.socketId !== socketId) {
      this.socketIndex.delete(p.socketId);
    }
    p.socketId = socketId;
    this.socketIndex.set(socketId, { code, sessionId });
    return p;
  }

  /**
   * Detach whatever (room, session) slot the given socket is currently
   * bound to and evict that player from their room. No-op if the socket
   * isn't holding a slot. Used as a "you only get one slot" enforcement
   * point in createRoom / joinRoom / rejoin to prevent the same client
   * from accidentally accumulating multiple ghost players (which is
   * how the same person showed up three times in one room).
   */
  private releaseSocketSlot(socketId: string): void {
    const ref = this.socketIndex.get(socketId);
    if (!ref) return;
    this.socketIndex.delete(socketId);
    // Best-effort detach the socket from the room's broadcast channel
    // so it stops receiving snapshots for the old room while it joins
    // a different one.
    const sock = this.io.sockets.sockets.get(socketId);
    if (sock) sock.leave(`room:${ref.code}`);
    this.evict(ref.code, ref.sessionId, "leave");
  }

  handleDisconnect(
    socketId: string,
  ): { room: InternalRoom; player: InternalPlayer } | null {
    const ref = this.socketIndex.get(socketId);
    this.socketIndex.delete(socketId);
    if (!ref) return null;
    const room = this.rooms.get(ref.code);
    if (!room) return null;
    const p = room.players.get(ref.sessionId);
    if (!p) return null;
    p.socketId = null;
    if (p.graceTimer) clearTimeout(p.graceTimer);
    p.graceTimer = setTimeout(() => {
      this.evict(room.code, p.id, "grace");
    }, PLAYER_GRACE_MS);
    // If this player was the only one we were still waiting on to
    // finish, re-evaluate the room phase immediately instead of
    // waiting out the full grace window — `checkAllFinished` only
    // counts CONNECTED players, so the moment they go offline the
    // remaining connected set may already be 100% finished.
    if (room.phase === "playing") this.checkAllFinished(room);
    return { room, player: p };
  }

  evict(code: string, sessionId: string, reason: "leave" | "grace"): void {
    const room = this.rooms.get(code);
    if (!room) return;
    const p = room.players.get(sessionId);
    if (!p) return;
    if (p.graceTimer) clearTimeout(p.graceTimer);
    // Drop any socketIndex entries pointing at this seat. Previously
    // only handleDisconnect() did this, which meant an explicit
    // `room:leave` left a dangling index entry — the same socket then
    // could end up mapped to a non-existent session, confusing every
    // subsequent action.
    if (p.socketId) this.socketIndex.delete(p.socketId);
    room.players.delete(sessionId);
    // Anti-spam rule: if the HOST leaves the lobby (or the post-match
    // results screen), the entire room shuts down rather than being
    // handed off to a random player. This prevents the "create a room,
    // bail, leave it as a public listing zombie" attack pattern. We
    // intentionally do NOT close mid-match (loading/countdown/playing)
    // so a host's network blip during a song doesn't kill everyone's
    // run — the standard host-promotion path still applies there.
    const wasHost = room.hostId === sessionId;
    if (wasHost && (room.phase === "lobby" || room.phase === "results")) {
      this.emitNotice(
        code,
        reason === "leave" ? "leave" : "info",
        `${p.name || "host"} ${reason === "leave" ? "left" : "disconnected"}`,
      );
      this.closeRoom(
        room,
        reason === "leave"
          ? "Host closed the room"
          : "Host disconnected — room closed",
      );
      return;
    }
    const promoted = this.maybePromoteHost(room);
    this.emitNotice(
      code,
      reason === "leave" ? "leave" : "info",
      `${p.name || "someone"} ${reason === "leave" ? "left" : "disconnected"}`,
    );
    if (promoted) {
      this.emitNotice(code, "host", `${promoted.name} is now host`);
    }
    if (room.players.size === 0) {
      this.scheduleEmptyTtl(room);
    } else {
      if (room.phase === "loading") this.checkAllReady(room);
      else if (room.phase === "playing") this.checkAllFinished(room);
    }
    this.emitSnapshot(code);
  }

  /**
   * Tear a room down completely: notify every remaining player, drop
   * all timers, clear socket indexes, and remove the room from the
   * registry. Used by the host-leaves-lobby rule and the inactivity
   * timer. Each player gets a `room:kicked` so the client can show a
   * polite "room closed" splash and redirect home — same UX as a real
   * kick, just with a different reason string.
   */
  private closeRoom(room: InternalRoom, reason: string): void {
    for (const p of room.players.values()) {
      if (p.graceTimer) {
        clearTimeout(p.graceTimer);
        p.graceTimer = null;
      }
      if (p.socketId) {
        this.io.to(p.socketId).emit("room:kicked", { reason });
        this.socketIndex.delete(p.socketId);
        const sock = this.io.sockets.sockets.get(p.socketId);
        if (sock) sock.leave(`room:${room.code}`);
      }
    }
    room.players.clear();
    if (room.loadingTimer) {
      clearTimeout(room.loadingTimer);
      room.loadingTimer = null;
    }
    if (room.emptyTtlTimer) {
      clearTimeout(room.emptyTtlTimer);
      room.emptyTtlTimer = null;
    }
    if (room.inactivityTimer) {
      clearTimeout(room.inactivityTimer);
      room.inactivityTimer = null;
    }
    this.clearMatchSafetyTimer(room);
    this.rooms.delete(room.code);
  }

  private maybePromoteHost(room: InternalRoom): InternalPlayer | null {
    if (room.players.has(room.hostId)) return null;
    let next: InternalPlayer | null = null;
    for (const p of room.players.values()) {
      if (!next || p.joinedAt < next.joinedAt) next = p;
    }
    if (!next) return null;
    next.isHost = true;
    room.hostId = next.id;
    return next;
  }

  private scheduleEmptyTtl(room: InternalRoom): void {
    if (room.emptyTtlTimer) clearTimeout(room.emptyTtlTimer);
    room.emptyTtlTimer = setTimeout(() => {
      if (room.players.size !== 0) return;
      // Final timer cleanup before the room object is GC'd. Without
      // this an in-flight match-safety timer could still fire on a
      // deleted room and attempt to emit to a dead room channel.
      this.clearMatchSafetyTimer(room);
      if (room.loadingTimer) {
        clearTimeout(room.loadingTimer);
        room.loadingTimer = null;
      }
      if (room.inactivityTimer) {
        clearTimeout(room.inactivityTimer);
        room.inactivityTimer = null;
      }
      this.rooms.delete(room.code);
    }, EMPTY_ROOM_TTL_MS);
  }

  /* ---- name / song / catalog ---- */

  setName(code: string, sessionId: string, raw: unknown): void {
    const room = this.rooms.get(code);
    if (!room) return;
    const p = room.players.get(sessionId);
    if (!p) return;
    const name = sanitizeName(raw);
    if (!name || name === p.name) return;
    p.name = name;
    this.emitSnapshot(code);
  }

  /**
   * Host-only room rename. Mirrors the create-time sanitization rules
   * (same `sanitizeRoomName` helper, same length cap) so a renamed room
   * can never end up with a title the create form wouldn't accept.
   * Empty input is rejected silently — a misclick shouldn't be able to
   * wipe a room's identity in the public browser.
   */
  setRoomName(code: string, sessionId: string, raw: unknown): void {
    const room = this.rooms.get(code);
    if (!room) return;
    if (room.hostId !== sessionId) return;
    const name = sanitizeRoomName(raw);
    if (!name || name === room.name) return;
    room.name = name;
    this.emitSnapshot(code);
  }

  /**
   * Host-only visibility toggle. Strict whitelist on the wire string
   * so a stale client can't smuggle a bogus value into the room state
   * (the listing helper would crash on `room.visibility !== "public"`
   * comparisons being unexpectedly truthy / falsy with garbage). No-op
   * when the value already matches.
   */
  setRoomVisibility(code: string, sessionId: string, raw: unknown): void {
    const room = this.rooms.get(code);
    if (!room) return;
    if (room.hostId !== sessionId) return;
    if (raw !== "public" && raw !== "private") return;
    if (room.visibility === raw) return;
    room.visibility = raw;
    this.emitSnapshot(code);
  }

  setSong(code: string, sessionId: string, song: unknown): void {
    const room = this.rooms.get(code);
    if (!room) throw new RoomError("ROOM_NOT_FOUND", "Room not found");
    if (room.hostId !== sessionId) {
      throw new RoomError("NOT_HOST", "Only the host can pick");
    }
    if (room.phase !== "lobby") {
      throw new RoomError("BAD_PHASE", "Songs can only be picked in the lobby");
    }
    const s = song as Partial<SongRef> | null;
    if (!s || typeof s.beatmapsetId !== "number") {
      throw new RoomError("BAD_SONG", "Invalid song selection");
    }
    // `durationSec` is optional on SongRef (added after launch). Validate
    // it as a finite, positive integer in a sane range so a malicious or
    // stale client can't smuggle NaN / Infinity / a junk number through
    // — the lobby formatter would render garbage. Anything weird → drop
    // the field; UI falls back to the mirror name like before.
    const rawDuration =
      typeof s.durationSec === "number" ? s.durationSec : undefined;
    const durationSec =
      rawDuration !== undefined &&
      Number.isFinite(rawDuration) &&
      rawDuration > 0 &&
      rawDuration < 60 * 60
        ? Math.round(rawDuration)
        : undefined;
    room.selectedSong = {
      beatmapsetId: s.beatmapsetId,
      title: String(s.title ?? "Untitled").slice(0, 80),
      artist: String(s.artist ?? "Unknown").slice(0, 80),
      source: String(s.source ?? "host").slice(0, 32),
      ...(durationSec !== undefined ? { durationSec } : {}),
    };
    // Picking a fresh song invalidates the room's ready quorum — any
    // pre-clicked "I'm ready" was for the previous selection. Clearing
    // here keeps the host's "everyone ready" indicator honest: every
    // player has to re-affirm they want THIS song before the host's
    // start button lights green.
    for (const p of room.players.values()) p.lobbyReady = false;
  }

  /**
   * Track the host's current difficulty pick on the room state.
   *
   * Stored continuously (not just at start-time) so the server has a
   * canonical record of "what the host currently has highlighted" for
   * future server-side checks (e.g. validating that the picked tier is
   * available on the chosen song). The host still has to explicitly
   * click "Start match" to begin loading — there's no auto-start path
   * that consumes this.
   */
  setMode(code: string, sessionId: string, mode: unknown): void {
    const room = this.rooms.get(code);
    if (!room) return;
    if (room.hostId !== sessionId) return;
    if (room.phase !== "lobby") return;
    if (
      mode !== "easy" &&
      mode !== "normal" &&
      mode !== "hard" &&
      mode !== "insane" &&
      mode !== "expert"
    ) {
      return;
    }
    room.selectedMode = mode;
    // No snapshot emit — mode is host-local UI state most of the time
    // (the host's own picker is what's authoritative). We don't want a
    // fan-out on every difficulty button click.
  }

  async ensureCatalog(code: string, refresh: boolean): Promise<CatalogItem[]> {
    const room = this.rooms.get(code);
    if (!room) throw new RoomError("ROOM_NOT_FOUND", "Room gone");
    if (room.catalog && !refresh) return room.catalog;
    const items = await fetchCatalog();
    room.catalog = items;
    room.catalogFetchedAt = Date.now();
    return items;
  }

  /* ---- phase transitions ---- */

  startLoading(code: string, sessionId: string, mode: unknown): void {
    const room = this.rooms.get(code);
    if (!room) throw new RoomError("ROOM_NOT_FOUND", "Room not found");
    if (room.hostId !== sessionId) throw new RoomError("NOT_HOST", "Only host can start");
    if (room.phase !== "lobby") throw new RoomError("BAD_PHASE", "Not in lobby");
    if (!room.selectedSong) throw new RoomError("NO_SONG", "Pick a song first");
    // Whitelist the 5 Syncle tiers. Keeps the wire format strict so a
    // malicious / outdated client can't smuggle a bogus mode string into
    // a room snapshot, and stays in lockstep with the ChartMode union.
    if (
      mode !== "easy" &&
      mode !== "normal" &&
      mode !== "hard" &&
      mode !== "insane" &&
      mode !== "expert"
    ) {
      throw new RoomError("BAD_MODE", "Invalid difficulty");
    }
    room.phase = "loading";
    room.selectedMode = mode;
    room.startsAt = null;
    room.songStartedAt = null;
    for (const p of room.players.values()) {
      p.ready = false;
      // Lobby-ready is the gate INTO loading — once we're in loading
      // it's served its purpose and the next return-to-lobby starts
      // every player at "not ready" again.
      p.lobbyReady = false;
      p.live = emptyLive();
      p.final = null;
      p.postChoice = null;
    }
    if (room.loadingTimer) clearTimeout(room.loadingTimer);
    room.loadingTimer = setTimeout(() => {
      this.tryStartCountdown(room, /*forced*/ true);
    }, LOADING_DEADLINE_MS);
    this.io.to(`room:${code}`).emit("phase:loading", {
      song: room.selectedSong,
      mode: room.selectedMode,
      deadline: Date.now() + LOADING_DEADLINE_MS,
    });
    this.emitSnapshot(code);
  }

  cancelLoading(code: string, sessionId: string): void {
    const room = this.rooms.get(code);
    if (!room) return;
    if (room.hostId !== sessionId) {
      throw new RoomError("NOT_HOST", "Only host can cancel");
    }
    if (room.phase !== "loading") return;
    this.transitionToLobby(room);
  }

  markReady(code: string, sessionId: string): void {
    const room = this.rooms.get(code);
    if (!room || room.phase !== "loading") return;
    const p = room.players.get(sessionId);
    if (!p || p.ready) return;
    p.ready = true;
    this.emitNotice(code, "ready", `${p.name || "someone"} is ready`);
    this.emitSnapshot(code);
    this.checkAllReady(room);
  }

  markLoadFailed(code: string, sessionId: string, reason: string): void {
    const room = this.rooms.get(code);
    if (!room) return;
    const p = room.players.get(sessionId);
    if (!p) return;
    this.emitNotice(
      code,
      "loadFailed",
      `${p.name || "someone"} couldn't load: ${reason}`,
    );
  }

  private checkAllReady(room: InternalRoom): void {
    const connected = [...room.players.values()].filter((p) => p.socketId !== null);
    if (connected.length === 0) return;
    if (connected.every((p) => p.ready)) this.tryStartCountdown(room, false);
  }

  private tryStartCountdown(room: InternalRoom, forced: boolean): void {
    if (room.phase !== "loading") return;
    const ready = [...room.players.values()].filter(
      (p) => p.ready && p.socketId !== null,
    );
    if (ready.length === 0) {
      this.emitNotice(
        room.code,
        "info",
        forced
          ? "Nobody finished loading in time, back to lobby"
          : "Loading cancelled",
      );
      this.transitionToLobby(room);
      return;
    }
    // Forced-start path (deadline elapsed, at least one player ready):
    // we DON'T kick the slow players. They stay in the room and
    // continue downloading / decoding; once their client finishes it
    // calls `client:ready` (which is now a no-op past loading), or
    // their MultiGame mounts and the page's late-join recovery path
    // re-runs the load + decode. The schedule effect then seeks the
    // audio by `now - startsAt` so they slot into the song timeline
    // at the right offset. The room owner gets a soft notice so they
    // know who is hopping in late.
    if (forced) {
      const stragglers = [...room.players.values()].filter(
        (p) => p.socketId !== null && !p.ready,
      );
      if (stragglers.length > 0) {
        const names = stragglers
          .map((p) => p.name || "someone")
          .join(", ");
        this.emitNotice(
          room.code,
          "info",
          `Starting without ${names} — they can join in late`,
        );
      }
    }
    if (room.loadingTimer) {
      clearTimeout(room.loadingTimer);
      room.loadingTimer = null;
    }
    room.phase = "countdown";
    room.startsAt = Date.now() + COUNTDOWN_LEAD_MS;
    this.io
      .to(`room:${room.code}`)
      .emit("phase:countdown", { startsAt: room.startsAt });
    this.emitSnapshot(room.code);

    const delay = Math.max(0, room.startsAt - Date.now());
    setTimeout(() => {
      if (room.phase !== "countdown") return;
      room.phase = "playing";
      room.songStartedAt = Date.now();
      // Defense in depth: scrub any `final` that somehow leaked into
      // a player record before the song actually started. Today
      // `applyFinished` is gated on `phase === "playing"`, but if a
      // future change re-introduces a pre-play write path (or a bug
      // sneaks one in), this guarantees that the standings table
      // can't be poisoned by a value the player didn't earn during
      // this round's actual playback.
      for (const p of room.players.values()) {
        p.final = null;
        p.live = emptyLive();
      }
      this.io
        .to(`room:${room.code}`)
        .emit("phase:playing", { songStartedAt: room.songStartedAt });
      this.emitSnapshot(room.code);
      // Arm the wall-clock safety net the moment we enter "playing"
      // so even a worst-case "every connected client lost their
      // player:finished packet" still produces a results screen.
      this.armMatchSafetyTimer(room);
    }, delay);
  }

  /**
   * Schedule (or re-schedule) the per-room safety net that guarantees a
   * "results" transition even if no `player:finished` event ever
   * arrives. Fires at `songStartedAt + songDurationMs + grace`. Uses a
   * generous fallback duration when the host's `selectedSong` doesn't
   * carry a `durationSec` field (legacy mirror payloads).
   */
  private armMatchSafetyTimer(room: InternalRoom): void {
    if (room.matchSafetyTimer) {
      clearTimeout(room.matchSafetyTimer);
      room.matchSafetyTimer = null;
    }
    if (room.phase !== "playing" || room.songStartedAt === null) return;
    const durationSec = room.selectedSong?.durationSec;
    const songMs =
      typeof durationSec === "number" && durationSec > 0
        ? Math.round(durationSec * 1000)
        : MATCH_MAX_DURATION_FALLBACK_MS;
    const elapsed = Date.now() - room.songStartedAt;
    const remaining = Math.max(0, songMs - elapsed) + MATCH_RESULTS_GRACE_MS;
    room.matchSafetyTimer = setTimeout(() => {
      room.matchSafetyTimer = null;
      this.forceTransitionToResults(room);
    }, remaining);
  }

  private clearMatchSafetyTimer(room: InternalRoom): void {
    if (!room.matchSafetyTimer) return;
    clearTimeout(room.matchSafetyTimer);
    room.matchSafetyTimer = null;
  }

  /**
   * Last-resort "the song should be over by now" path. Synthesises a
   * `final` from each unfinished player's last `live` snapshot so the
   * standings show their actual progress (score + accuracy + max
   * combo) instead of zeros. Players who already sent
   * `player:finished` keep their authoritative `final` untouched.
   */
  private forceTransitionToResults(room: InternalRoom): void {
    if (room.phase !== "playing") return;
    for (const p of room.players.values()) {
      if (p.final !== null) continue;
      // Mirror what the client would have sent: copy the latest
      // server-known live values into a final shape. notesPlayed /
      // totalNotes / hits are zero-default when the player never
      // submitted a single score update (e.g. chart load failure),
      // which is exactly what we want — the standings row will read
      // "didn't play" instead of inventing fake hits.
      p.final = {
        score: p.live.score,
        accuracy: p.live.accuracy,
        maxCombo: p.live.maxCombo,
        hits: { ...p.live.hits },
        notesPlayed: p.live.notesPlayed,
        totalNotes: p.live.totalNotes,
      };
      p.live = { ...p.live, finished: true };
    }
    this.transitionToResults(room);
  }

  applyScoreUpdate(code: string, sessionId: string, raw: unknown): void {
    const room = this.rooms.get(code);
    if (!room || room.phase !== "playing") return;
    const p = room.players.get(sessionId);
    if (!p) return;
    const score = raw as Partial<LiveScore> | null;
    if (!score || typeof score.score !== "number") return;
    p.live = {
      score: clampNum(score.score, 0, 1e9),
      combo: clampNum(score.combo, 0, 1e6),
      maxCombo: clampNum(score.maxCombo, 0, 1e6),
      accuracy: clampNum(score.accuracy, 0, 100),
      notesPlayed: clampNum(score.notesPlayed, 0, 1e6),
      totalNotes: clampNum(score.totalNotes, 0, 1e6),
      hits: {
        perfect: clampNum(score.hits?.perfect, 0, 1e6),
        great: clampNum(score.hits?.great, 0, 1e6),
        good: clampNum(score.hits?.good, 0, 1e6),
        miss: clampNum(score.hits?.miss, 0, 1e6),
      },
      health: clampNum(score.health, 0, 1),
      finished: !!score.finished,
    };
    this.scheduleScoreboard(code);
  }

  applyFinished(code: string, sessionId: string, raw: unknown): void {
    const room = this.rooms.get(code);
    if (!room) return;
    // Anti-cheat: only accept `client:finished` while the song is
    // ACTUALLY playing. The previous `phase === "countdown"` carve-out
    // was a leaderboard exploit — a malicious client could submit a
    // forged `final` (with score / combo clamped at the upper bounds
    // below, so still a "fake high score") BEFORE the song even
    // started, locking it in `p.final`. Standings (`standingsOf`)
    // prefer `p.final` over `p.live`, so the cheater would appear
    // ranked without playing a single note. Restricting this to
    // `playing` means a finished payload requires the song to have
    // actually been running.
    if (room.phase !== "playing") return;
    const p = room.players.get(sessionId);
    if (!p) return;
    const final = raw as Partial<FinalStats> | null;
    if (!final || typeof final.score !== "number") return;
    p.final = {
      score: clampNum(final.score, 0, 1e9),
      accuracy: clampNum(final.accuracy, 0, 100),
      maxCombo: clampNum(final.maxCombo, 0, 1e6),
      hits: {
        perfect: clampNum(final.hits?.perfect, 0, 1e6),
        great: clampNum(final.hits?.great, 0, 1e6),
        good: clampNum(final.hits?.good, 0, 1e6),
        miss: clampNum(final.hits?.miss, 0, 1e6),
      },
      notesPlayed: clampNum(final.notesPlayed, 0, 1e6),
      totalNotes: clampNum(final.totalNotes, 0, 1e6),
    };
    p.live = { ...p.live, finished: true, score: p.final.score };
    this.checkAllFinished(room);
  }

  private checkAllFinished(room: InternalRoom): void {
    if (room.phase !== "playing") return;
    const connected = [...room.players.values()].filter((p) => p.socketId !== null);
    if (connected.length === 0) return;
    if (connected.every((p) => p.final !== null)) this.transitionToResults(room);
  }

  private transitionToResults(room: InternalRoom): void {
    // Disarm the safety net the moment we flip — whether this was a
    // clean "everyone finished" transition or the safety net itself
    // firing, we don't want a stale timer left behind that could fire
    // again after the room has already moved on (results → lobby →
    // next song's playing phase reuses the same room object).
    this.clearMatchSafetyTimer(room);
    room.phase = "results";
    const { standings, winnerId } = this.standingsOf(room);
    this.io
      .to(`room:${room.code}`)
      .emit("phase:results", { standings, winnerId });
    this.emitSnapshot(room.code);
  }

  applyChoice(code: string, sessionId: string, choice: unknown): void {
    const room = this.rooms.get(code);
    if (!room || room.phase !== "results") return;
    const p = room.players.get(sessionId);
    if (!p) return;
    if (choice !== "stay" && choice !== "leave") return;
    p.postChoice = choice;
    this.emitSnapshot(code);
  }

  hostReturnToLobby(code: string, sessionId: string): void {
    const room = this.rooms.get(code);
    if (!room) return;
    if (room.hostId !== sessionId) {
      throw new RoomError("NOT_HOST", "Only host can do that");
    }
    if (room.phase !== "results") return;
    this.returnToLobbyShared(room);
  }

  /**
   * Any-player-can-call sibling of `hostReturnToLobby`. The new UX is
   * that anyone clicking "Back to room" on the results screen pulls
   * everyone back; players who already chose "leave main menu" are
   * disconnected by now (their client called `room:leave` before
   * navigating away) so this is just a phase flip.
   *
   * Idempotent: a second click during the same results window finds
   * the room already in lobby and silently no-ops.
   */
  anyReturnToLobby(code: string, sessionId: string): void {
    const room = this.rooms.get(code);
    if (!room) return;
    if (!room.players.has(sessionId)) return;
    if (room.phase !== "results") return;
    this.returnToLobbyShared(room);
  }

  private returnToLobbyShared(room: InternalRoom): void {
    const leavers: string[] = [];
    for (const p of room.players.values()) {
      if (p.postChoice === "leave") leavers.push(p.id);
    }
    for (const id of leavers) this.evict(room.code, id, "leave");
    const fresh = this.rooms.get(room.code);
    if (!fresh) return;
    this.transitionToLobby(fresh);
  }

  /* ---- lobby-ready ---- */

  setLobbyReady(code: string, sessionId: string, ready: unknown): void {
    const room = this.rooms.get(code);
    if (!room) return;
    if (room.phase !== "lobby") return;
    const p = room.players.get(sessionId);
    if (!p) return;
    const next = !!ready;
    if (p.lobbyReady === next) return;
    p.lobbyReady = next;
    this.emitSnapshot(code);
    // Note: there is intentionally NO auto-start here. By design, the
    // host always has to click "Start match" themselves — the all-ready
    // signal in the lobby UI just tells them they can do so without
    // overriding anyone. This was changed back from auto-start because
    // hosts wanted explicit control over the start moment (e.g. to
    // wait for a late friend, swap songs, etc.) even after the room
    // hits full ready quorum.
  }

  /* ---- moderation ---- */

  kickPlayer(code: string, hostSession: string, target: unknown): void {
    const room = this.rooms.get(code);
    if (!room) return;
    if (room.hostId !== hostSession) {
      throw new RoomError("NOT_HOST", "Only host can kick");
    }
    if (typeof target !== "string") return;
    if (target === hostSession) {
      throw new RoomError("CANT_KICK_SELF", "Use 'leave' to step down");
    }
    const p = room.players.get(target);
    if (!p) return;
    // Tell the kicked socket FIRST so the client can show a polite
    // splash before its socket is yanked from the room. Once we evict
    // they leave the broadcast room and won't receive further events.
    if (p.socketId) {
      this.io.to(p.socketId).emit("room:kicked", {
        reason: `You were kicked by the host`,
      });
    }
    this.emitNotice(code, "kick", `${p.name || "someone"} was kicked`);
    this.evict(code, target, "leave");
  }

  setMute(
    code: string,
    hostSession: string,
    target: unknown,
    muted: unknown,
  ): void {
    const room = this.rooms.get(code);
    if (!room) return;
    if (room.hostId !== hostSession) {
      throw new RoomError("NOT_HOST", "Only host can mute");
    }
    if (typeof target !== "string") return;
    if (target === hostSession) {
      throw new RoomError("CANT_MUTE_SELF", "Hosts can't mute themselves");
    }
    const p = room.players.get(target);
    if (!p) return;
    const next = !!muted;
    if (p.muted === next) return;
    p.muted = next;
    this.emitNotice(
      code,
      "mute",
      `${p.name || "someone"} was ${next ? "muted" : "unmuted"}`,
    );
    this.emitSnapshot(code);
  }

  /* ---- chat ---- */

  sendChat(code: string, sessionId: string, raw: unknown): void {
    const room = this.rooms.get(code);
    if (!room) return;
    const p = room.players.get(sessionId);
    if (!p) return;
    if (p.muted) return;
    const payload = raw as { text?: unknown } | null;
    const text = sanitizeChatText(payload?.text);
    if (!text) return;
    // Sliding-window rate limit. Filter timestamps older than the
    // window, then check against CHAT_RATE_LIMIT. A spammer hitting
    // the cap is silently dropped — no error event so they can't
    // probe the limiter for timing leaks.
    const now = Date.now();
    p.chatTimestamps = p.chatTimestamps.filter(
      (t) => now - t < CHAT_RATE_WINDOW_MS,
    );
    if (p.chatTimestamps.length >= CHAT_RATE_LIMIT) return;
    p.chatTimestamps.push(now);
    const msg: ChatMessage = {
      id: room.nextChatId++,
      at: now,
      kind: "user",
      authorId: p.id,
      authorName: p.name || "anon",
      text,
    };
    this.pushChat(room, msg);
  }

  /** Push a chat message into the room's rolling history + broadcast. */
  private pushChat(room: InternalRoom, msg: ChatMessage): void {
    room.chat.push(msg);
    if (room.chat.length > MAX_CHAT_HISTORY) {
      // Drop the oldest in-place rather than slicing for a fresh array
      // on every message — splice mutates and keeps the same reference,
      // which lets React diffs use the cap-bounded list as a stable
      // identity signal across tics.
      room.chat.splice(0, room.chat.length - MAX_CHAT_HISTORY);
    }
    this.io.to(`room:${room.code}`).emit("chat:message", msg);
  }

  private transitionToLobby(room: InternalRoom): void {
    if (room.loadingTimer) {
      clearTimeout(room.loadingTimer);
      room.loadingTimer = null;
    }
    // Belt-and-braces: the safety timer is normally cleared by
    // transitionToResults before we ever land here, but a "host
    // cancelled loading" / forced lobby return path can skip results
    // entirely. Clearing unconditionally keeps the room object
    // timer-free across phase recycles.
    this.clearMatchSafetyTimer(room);
    room.phase = "lobby";
    // `selectedMode` is cleared so the host's next tap on a difficulty
    // button re-fires `host:setMode` and the server doesn't carry a
    // stale mode hint into the new round.
    room.selectedMode = null;
    room.startsAt = null;
    room.songStartedAt = null;
    for (const p of room.players.values()) {
      p.ready = false;
      // Coming back from results / loading ALWAYS clears lobby-ready
      // so nobody is auto-starting the next round just because they
      // were ready for the last one. Keeps the "I want to play this"
      // signal explicit per-round.
      p.lobbyReady = false;
      p.live = emptyLive();
      p.final = null;
      p.postChoice = null;
    }
    this.io.to(`room:${room.code}`).emit("phase:lobby");
    this.emitSnapshot(room.code);
  }

  refOf(socketId: string) {
    return this.socketIndex.get(socketId);
  }

  hasRoom(code: string): boolean {
    return this.rooms.has(code);
  }

  hasPlayer(code: string, sessionId: string): boolean {
    return !!this.rooms.get(code)?.players.get(sessionId);
  }
}

/* -------------------------------------------------------------------------- */
/* Wiring                                                                     */
/* -------------------------------------------------------------------------- */

function ackOk<T>(data: T): AckResult<T> {
  return { ok: true, data };
}

function ackErr(e: unknown): AckResult<never> {
  if (e instanceof RoomError) {
    return { ok: false, code: e.errCode, message: e.message };
  }
  const msg = e instanceof Error ? e.message : String(e);
  return { ok: false, code: "ERR", message: msg };
}

export function wireSocketServer(io: IO): void {
  const reg = new RoomRegistry(io);

  io.on("connection", (socket: Sock) => {
    /* ---- room lifecycle ---- */

    socket.on("room:create", (payload, ack) => {
      try {
        const displayName = sanitizeName(payload?.displayName) || "Player";
        // Empty room name → fall back to "$NICKNAME's room" so the
        // browser listing always has SOMETHING readable. Visibility
        // defaults to "private" for backwards compat with older
        // clients that didn't ship the visibility flag.
        const roomNameRaw = sanitizeRoomName(payload?.name);
        const roomName = roomNameRaw || `${displayName}'s room`;
        const visibility: RoomVisibility =
          payload?.visibility === "public" ? "public" : "private";
        const { code, sessionId } = reg.createRoom(
          socket.id,
          displayName,
          roomName,
          visibility,
        );
        socket.join(`room:${code}`);
        ack?.(ackOk({ code, sessionId }));
        reg.emitSnapshot(code);
      } catch (e) {
        ack?.(ackErr(e));
      }
    });

    socket.on("rooms:listPublic", (_payload, ack) => {
      try {
        ack?.(ackOk({ rooms: reg.listPublicRooms() }));
      } catch (e) {
        ack?.(ackErr(e));
      }
    });

    socket.on("room:join", (payload, ack) => {
      try {
        const code = String(payload?.code ?? "").toUpperCase();
        if (!isValidRoomCode(code)) {
          throw new RoomError("BAD_CODE", "Invalid room code");
        }
        const name = sanitizeName(payload?.name) || "Player";
        if (
          payload?.sessionId &&
          reg.hasRoom(code) &&
          reg.hasPlayer(code, payload.sessionId)
        ) {
          const p = reg.rejoin(code, payload.sessionId, socket.id);
          if (name) p.name = name;
          socket.join(`room:${code}`);
          ack?.(ackOk({ code, sessionId: p.id }));
          reg.emitSnapshot(code);
          return;
        }
        const { sessionId } = reg.joinRoom(code, socket.id, name);
        socket.join(`room:${code}`);
        ack?.(ackOk({ code, sessionId }));
        reg.emitNotice(code, "join", `${name} joined`);
        reg.emitSnapshot(code);
      } catch (e) {
        ack?.(ackErr(e));
      }
    });

    socket.on("room:rejoin", (payload, ack) => {
      try {
        const code = String(payload?.code ?? "").toUpperCase();
        if (!isValidRoomCode(code)) {
          throw new RoomError("BAD_CODE", "Invalid room code");
        }
        if (typeof payload?.sessionId !== "string") {
          throw new RoomError("BAD_SESSION", "Missing session id");
        }
        const p = reg.rejoin(code, payload.sessionId, socket.id);
        socket.join(`room:${code}`);
        ack?.(ackOk({ code }));
        reg.emitNotice(code, "info", `${p.name} reconnected`);
        reg.emitSnapshot(code);
      } catch (e) {
        ack?.(ackErr(e));
      }
    });

    socket.on("room:leave", () => {
      const ref = reg.refOf(socket.id);
      if (!ref) return;
      reg.evict(ref.code, ref.sessionId, "leave");
      socket.leave(`room:${ref.code}`);
    });

    socket.on("room:setName", (payload) => {
      const ref = reg.refOf(socket.id);
      if (!ref) return;
      reg.setName(ref.code, ref.sessionId, payload?.name);
    });

    socket.on("host:setRoomName", (payload) => {
      const ref = reg.refOf(socket.id);
      if (!ref) return;
      reg.setRoomName(ref.code, ref.sessionId, payload?.name);
    });

    socket.on("host:setVisibility", (payload) => {
      const ref = reg.refOf(socket.id);
      if (!ref) return;
      reg.setRoomVisibility(ref.code, ref.sessionId, payload?.visibility);
    });

    /* ---- catalog ---- */

    socket.on("host:catalogRequest", async (payload, ack) => {
      try {
        const ref = reg.refOf(socket.id);
        if (!ref) throw new RoomError("NOT_IN_ROOM", "Not in a room");
        const items = await reg.ensureCatalog(ref.code, !!payload?.refresh);
        ack?.(ackOk({ items }));
      } catch (e) {
        ack?.(ackErr(e));
      }
    });

    socket.on("host:selectSong", (payload) => {
      const ref = reg.refOf(socket.id);
      if (!ref) return;
      try {
        reg.setSong(ref.code, ref.sessionId, payload);
        reg.emitSnapshot(ref.code);
      } catch (e) {
        socket.emit("error", ackErr(e) as unknown as { code: string; message: string });
      }
    });

    socket.on("host:start", (payload) => {
      const ref = reg.refOf(socket.id);
      if (!ref) return;
      try {
        reg.startLoading(ref.code, ref.sessionId, payload?.mode);
      } catch (e) {
        socket.emit("error", ackErr(e) as unknown as { code: string; message: string });
      }
    });

    socket.on("host:cancelLoading", () => {
      const ref = reg.refOf(socket.id);
      if (!ref) return;
      try {
        reg.cancelLoading(ref.code, ref.sessionId);
      } catch (e) {
        socket.emit("error", ackErr(e) as unknown as { code: string; message: string });
      }
    });

    socket.on("host:returnToLobby", () => {
      const ref = reg.refOf(socket.id);
      if (!ref) return;
      try {
        reg.hostReturnToLobby(ref.code, ref.sessionId);
      } catch (e) {
        socket.emit("error", ackErr(e) as unknown as { code: string; message: string });
      }
    });

    /* ---- back-to-lobby (any player) ---- */

    socket.on("room:returnToLobby", () => {
      const ref = reg.refOf(socket.id);
      if (!ref) return;
      reg.anyReturnToLobby(ref.code, ref.sessionId);
    });

    /* ---- ready / mode (lobby gates) ---- */

    socket.on("room:setReady", (payload) => {
      const ref = reg.refOf(socket.id);
      if (!ref) return;
      reg.setLobbyReady(ref.code, ref.sessionId, payload?.ready);
    });

    // Continuous host mode tracking. Host's picker fires this on every
    // difficulty button click so the server-side `selectedMode` stays
    // in lockstep with the host's UI; the server uses this as the
    // canonical record of which tier the room is queued for.
    socket.on("host:setMode", (payload) => {
      const ref = reg.refOf(socket.id);
      if (!ref) return;
      reg.setMode(ref.code, ref.sessionId, payload?.mode);
    });

    /* ---- moderation ---- */

    socket.on("host:kick", (payload) => {
      const ref = reg.refOf(socket.id);
      if (!ref) return;
      try {
        reg.kickPlayer(ref.code, ref.sessionId, payload?.sessionId);
      } catch (e) {
        socket.emit("error", ackErr(e) as unknown as { code: string; message: string });
      }
    });

    socket.on("host:mute", (payload) => {
      const ref = reg.refOf(socket.id);
      if (!ref) return;
      try {
        reg.setMute(ref.code, ref.sessionId, payload?.sessionId, payload?.muted);
      } catch (e) {
        socket.emit("error", ackErr(e) as unknown as { code: string; message: string });
      }
    });

    /* ---- chat ---- */

    socket.on("chat:send", (payload) => {
      const ref = reg.refOf(socket.id);
      if (!ref) return;
      reg.sendChat(ref.code, ref.sessionId, payload);
    });

    /* ---- gameplay ---- */

    socket.on("client:ready", () => {
      const ref = reg.refOf(socket.id);
      if (!ref) return;
      reg.markReady(ref.code, ref.sessionId);
    });

    socket.on("client:loadFailed", (payload) => {
      const ref = reg.refOf(socket.id);
      if (!ref) return;
      reg.markLoadFailed(ref.code, ref.sessionId, payload?.reason ?? "unknown");
    });

    socket.on("client:scoreUpdate", (payload) => {
      const ref = reg.refOf(socket.id);
      if (!ref) return;
      reg.applyScoreUpdate(ref.code, ref.sessionId, payload);
    });

    socket.on("client:finished", (payload) => {
      const ref = reg.refOf(socket.id);
      if (!ref) return;
      reg.applyFinished(ref.code, ref.sessionId, payload);
    });

    socket.on("client:choice", (payload) => {
      const ref = reg.refOf(socket.id);
      if (!ref) return;
      reg.applyChoice(ref.code, ref.sessionId, payload?.choice);
    });

    /* ---- disconnect ---- */

    socket.on("disconnect", () => {
      const ctx = reg.handleDisconnect(socket.id);
      if (ctx) reg.emitSnapshot(ctx.room.code);
    });
  });
}
