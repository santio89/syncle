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
  SCORE_UPDATE_MIN_INTERVAL_MS,
  ScoreboardEntry,
  ServerToClientEvents,
  SongRef,
  Standing,
  isValidRoomCode,
  sanitizeChatText,
  sanitizeName,
  sanitizeRoomName,
} from "@/lib/multi/protocol";
import {
  fetchCatalog,
  searchCatalogPage,
  browseCatalogPage,
  BROWSE_SORT_VALUES,
  type BrowseSort,
  type SearchCatalogResult,
} from "./catalog";

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
/**
 * Max wait between "host hits start" and "force-start the countdown".
 * If at least one player is ready by this deadline, the room enters
 * `countdown` with whoever's ready and the stragglers late-join when
 * their download/decode finishes (see `tryStartCountdown` forced-start
 * branch and `MultiGame.tsx` schedule effect's negative-`delayMs`
 * seek). If NOBODY is ready, the room bounces back to `lobby` instead.
 * Slow loaders are NEVER kicked — that was the old behaviour, replaced
 * with late-join in the v2 multiplayer pass.
 */
const LOADING_DEADLINE_MS = 30_000;
/**
 * Length of the lobby pre-start countdown shown after the host clicks
 * Start. Every client renders a centered "starting in 3, 2, 1…" overlay
 * during this window; the host's overlay also exposes a Cancel button
 * that aborts the queued start. The actual `_doStartLoading` only runs
 * once this elapses without a `host:cancelStart`.
 *
 * Kept short so it doesn't feel laggy — the goal is "yes I really
 * meant Start, here's a moment to abort", not "load anything in
 * advance". Anything ≥3 s gives a clear 3-2-1 cadence; less and the
 * cancel affordance is too tight to actually click.
 */
const PRESTART_COUNTDOWN_MS = 3_000;
/**
 * Grace between "everyone ready" and the wall-clock t0 for audio.
 * Sourced from the shared protocol constant so the server's
 * `phase:countdown` → `phase:playing` window matches exactly the
 * client's overlay sequence: "Get ready..." prompt (3 s) → "3 / 2 / 1"
 * numbers (3 s) → silent lead-in (2 s), total 8 s. If you change the
 * timing here, change the individual MATCH_*_MS constants in
 * `lib/multi/protocol.ts` instead so client + server stay in lockstep.
 */
const COUNTDOWN_LEAD_MS = MATCH_COUNTDOWN_LEAD_MS;
/** Score broadcast cadence (ms). 200 ms = 5 Hz, plenty smooth for a sidebar. */
const SCOREBOARD_TICK_MS = 200;

/**
 * TTL on per-room search cache entries. Mirrors typically reindex on the
 * order of minutes, and a host browsing pages of one query rarely takes
 * longer than a couple of minutes — so 5 min strikes the balance between
 * "fresh enough" and "actually saves the upstream a request".
 */
const SEARCH_CACHE_TTL_MS = 5 * 60_000;
/**
 * Capacity of the per-room search-cache LRU. Each entry is at most
 * SEARCH_PAGE_SIZE (50) catalog items × ~80-120 bytes ≈ 5 KB, so 32
 * entries caps memory at ~160 KB per room — trivial. Past 32 distinct
 * (query, page) tuples we evict oldest-first.
 */
const SEARCH_CACHE_MAX_ENTRIES = 32;

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
  /**
   * Wall-clock of the most recently ACCEPTED `client:scoreUpdate`. Used
   * to enforce `SCORE_UPDATE_MIN_INTERVAL_MS` so a malicious client can't
   * flood `applyScoreUpdate` faster than the honest 5 Hz throttle. A
   * single number is enough — we don't care about a rolling window for
   * scores, just "was the last accepted packet too recent."
   */
  lastScoreUpdateAt: number;
  /**
   * Whether this player is participating in the active match. See
   * `PlayerSnapshot.inMatch` for the routing semantics.
   *
   * Lifecycle:
   *   - Created at `false` (joining lands you in the lobby).
   *   - Flipped to `true` for every connected player on
   *     `startLoading`. That includes players who weren't
   *     `lobbyReady` — pressing Start grabs everyone.
   *   - Flipped back to `false` for every player on
   *     `transitionToLobby` (results → lobby, host:cancelMatch).
   *   - Flipped to `false` mid-match by `room:leaveMatch` (player
   *     opts out via the in-match menu's "Leave" button). Idempotent.
   *   - NEW players who join via `joinRoom` while the room is past
   *     the lobby phase start at `false` — they see the lobby with
   *     a "match in progress" indicator instead of being silently
   *     dropped into a half-played song.
   *   - Survives disconnect/reconnect inside the slot TTL: the
   *     player's slot retains `inMatch=true` so a mid-song refresh
   *     resumes the run.
   */
  inMatch: boolean;
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
  /**
   * Wall-clock ms when the host paused an in-progress match; null
   * when the match is running or no match is active. Set by
   * `pauseMatch`, cleared by `resumeMatch` (which also bumps
   * `songStartedAt` forward by the elapsed pause duration so the
   * audio-clock baseline stays consistent for late joiners and the
   * safety timer). Mirrored in `RoomSnapshot.pausedAt`.
   */
  pausedAt: number | null;
  /**
   * Wall-clock ms when the lobby pre-start countdown finishes (and we
   * call `_doStartLoading`). `null` whenever no start is queued.
   * Mirrored on `RoomSnapshot.prestartEndsAt` so every client renders
   * the centered "starting in N…" overlay against the same clock.
   */
  prestartEndsAt: number | null;
  /** Mode to launch into when the prestart timer elapses. */
  prestartMode: ChartMode | null;
  /** Pending timer that calls `_doStartLoading`. Cleared on cancel. */
  prestartTimer: NodeJS.Timeout | null;
  /** Rolling chat backlog, oldest first, capped at MAX_CHAT_HISTORY. */
  chat: ChatMessage[];
  /** Monotonically-incrementing chat message id (room-scoped). */
  nextChatId: number;
  catalog: CatalogItem[] | null;
  catalogFetchedAt: number | null;
  /**
   * Per-room LRU cache of paginated catalog pages — both text-search
   * AND no-query browse share this map. Keys are prefix-tagged to keep
   * the two views in their own namespaces:
   *   - `s|${normalizedQuery}|${page}` for text search
   *   - `b|${sort}|${page}` for sorted browse
   * Distinct from the random-discovery `catalog` field above because
   * those access patterns differ: random discovery is "show me a fresh
   * slice once" (single cached snapshot), pagination is "browse pages
   * of THIS view" (many small cached entries, evicted oldest-first).
   *
   * Bounded by SEARCH_CACHE_MAX_ENTRIES so a host bouncing between
   * dozens of queries / pages can't unbounded-grow the room object.
   * TTL is enforced lazily on read (no background sweep needed) so a
   * stale entry just gets re-fetched on next access — matches the
   * "5-minute freshness window" the upstream mirrors update on.
   */
  searchCache: Map<
    string,
    { result: SearchCatalogResult; at: number }
  > | null;
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
   * ALWAYS shows up — even if a `client:finished` packet from one of
   * the clients was lost, the chart never loaded for them, their tab
   * froze, etc. Without this timer the room would otherwise stay in
   * "playing" forever and nobody (not even players who cleanly
   * finished) would ever see their final standings.
   *
   * Cleared in every transition out of "playing" (results, lobby).
   */
  matchSafetyTimer: NodeJS.Timeout | null;
  /**
   * Wall-clock handle for the countdown→playing flip. Scheduled by
   * `tryStartCountdown` to fire at `room.startsAt`. Tracked here so
   * `closeRoom` (and any other forced exit from `countdown`) can
   * cancel it — without that, an inactivity-close or all-disconnect
   * during the 5s countdown lead-in would still queue a callback that
   * fires later and emits `phase:playing` to a `room:CODE` channel
   * with no live members. Harmless in practice, but it leaves the
   * `InternalRoom` reference alive in the closure for the duration
   * and pollutes the metric/log surface.
   */
  countdownTimer: NodeJS.Timeout | null;
  /**
   * Stringified payload of the last snapshot we emitted on this room,
   * used by `emitSnapshot` to skip identical re-broadcasts. Many call
   * sites flip a flag to its current value (host re-clicks "ready",
   * a snapshot is forced after `emitNotice`, the disconnect/reconnect
   * path runs even when the player's slot already showed `online`),
   * and serializing once + cmp-strings is cheaper than fanning the
   * full object out to N sockets through Socket.IO's encoder.
   *
   * Cleared on close to free the string. Stays warm across emits;
   * the payload is small enough (~1 KB at 8-player max) that holding
   * one copy per room is fine.
   */
  lastSnapshotJson: string | null;
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
    // Build the wire payload, then cheap-compare against the last one
    // we sent. Identical = nothing observable changed = skip the fan-
    // out entirely (no Socket.IO encode, no per-socket frame, no
    // wakeup on the client side). Activity is also NOT bumped on a
    // no-op: a snapshot with identical bytes means whatever called us
    // didn't actually mutate room state, which is precisely the kind
    // of churn the inactivity timer is supposed to ignore.
    const snap = this.snapshotOf(room);
    const json = JSON.stringify(snap);
    if (json === room.lastSnapshotJson) return;
    room.lastSnapshotJson = json;
    this.bumpActivity(room);
    this.io.to(`room:${code}`).emit("room:snapshot", snap);
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
        inMatch: p.inMatch,
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
      pausedAt: room.pausedAt,
      prestartEndsAt: room.prestartEndsAt,
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
      pausedAt: null,
      prestartEndsAt: null,
      prestartMode: null,
      prestartTimer: null,
      chat: [],
      nextChatId: 1,
      catalog: null,
      catalogFetchedAt: null,
      searchCache: null,
      emptyTtlTimer: null,
      loadingTimer: null,
      matchSafetyTimer: null,
      inactivityTimer: null,
      countdownTimer: null,
      lastSnapshotJson: null,
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
      lastScoreUpdateAt: 0,
      // Brand-new room — definitionally in lobby phase, so the
      // host is "in lobby". `inMatch` flips to true when they
      // press Start; for now they're a lobby participant.
      inMatch: false,
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
      lastScoreUpdateAt: 0,
      // Late-join routing: if the room is already past the lobby,
      // this player wasn't in the match when the host pressed Start.
      // They get the lobby UI with a "match in progress" indicator
      // — *not* dropped into a half-played song. They can still
      // chat / change settings / wait for the next round. When the
      // room cycles back to lobby, this flag stays false but is
      // ignored (lobby phase routes everyone to the Lobby anyway).
      inMatch: false,
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
    if (room.countdownTimer) {
      clearTimeout(room.countdownTimer);
      room.countdownTimer = null;
    }
    if (room.prestartTimer) {
      clearTimeout(room.prestartTimer);
      room.prestartTimer = null;
    }
    room.prestartEndsAt = null;
    room.prestartMode = null;
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

  /**
   * Text-query catalog search with per-room TTL'd LRU cache.
   *
   * `query` is normalized (trimmed, lowercased, internal whitespace
   * collapsed) so trivially-different inputs like "  ABBA  " and
   * "abba" share a single cache slot — the upstream mirrors are
   * case-insensitive anyway, so this is a pure cache-hit-rate win.
   *
   * Cache eviction:
   *   - Stale entries (older than SEARCH_CACHE_TTL_MS) are skipped on
   *     read and the result re-fetched. No background sweep — the next
   *     read on a stale key will simply overwrite it.
   *   - Capacity-driven LRU: when inserting past
   *     SEARCH_CACHE_MAX_ENTRIES, drop the oldest-inserted entry.
   *     Map iteration order in V8 is insertion order, so
   *     `cache.keys().next().value` IS the LRU candidate.
   */
  async searchCatalog(
    code: string,
    rawQuery: string,
    page: number,
  ): Promise<SearchCatalogResult> {
    const room = this.rooms.get(code);
    if (!room) throw new RoomError("ROOM_NOT_FOUND", "Room gone");
    const query = rawQuery.trim().toLowerCase().replace(/\s+/g, " ");
    if (!query) {
      throw new RoomError("BAD_QUERY", "Search query cannot be empty");
    }
    if (query.length > 64) {
      // Mirrors typically reject overlong queries with a 400; trim
      // here so the user sees a clean error instead of a mirror-shaped
      // network failure.
      throw new RoomError("BAD_QUERY", "Search query too long");
    }
    const safePage = Math.max(0, Math.floor(page));
    const cacheKey = `s|${query}|${safePage}`;

    if (!room.searchCache) {
      room.searchCache = new Map();
    }
    const cached = room.searchCache.get(cacheKey);
    if (cached && Date.now() - cached.at < SEARCH_CACHE_TTL_MS) {
      return cached.result;
    }

    const result = await searchCatalogPage({ query, page: safePage });
    room.searchCache.set(cacheKey, { result, at: Date.now() });

    while (room.searchCache.size > SEARCH_CACHE_MAX_ENTRIES) {
      const oldestKey = room.searchCache.keys().next().value;
      if (oldestKey === undefined) break;
      room.searchCache.delete(oldestKey);
    }

    return result;
  }

  /**
   * No-query catalog browse with explicit pagination + sort.
   *
   * Default sort is `ranked_desc` (newest-ranked first), which is what
   * a host opening the picker without a specific song in mind almost
   * always wants ("show me what's new"). Other sorts are validated
   * against `BROWSE_SORT_VALUES` server-side so the upstream never
   * sees a bogus param.
   *
   * `refresh: true` deletes the cached entry for the requested page
   * BEFORE fetching, so the host's ↻ button always pulls live data
   * even within the 5-minute TTL window.
   */
  async browseCatalog(
    code: string,
    rawSort: string | undefined,
    page: number,
    refresh: boolean,
  ): Promise<SearchCatalogResult> {
    const room = this.rooms.get(code);
    if (!room) throw new RoomError("ROOM_NOT_FOUND", "Room gone");
    const sort: BrowseSort = (BROWSE_SORT_VALUES as readonly string[]).includes(
      rawSort ?? "",
    )
      ? (rawSort as BrowseSort)
      : "ranked_desc";
    const safePage = Math.max(0, Math.floor(page));
    const cacheKey = `b|${sort}|${safePage}`;

    if (!room.searchCache) {
      room.searchCache = new Map();
    }
    if (refresh) {
      room.searchCache.delete(cacheKey);
    }
    const cached = room.searchCache.get(cacheKey);
    if (cached && Date.now() - cached.at < SEARCH_CACHE_TTL_MS) {
      return cached.result;
    }

    const result = await browseCatalogPage({ page: safePage, sort });
    room.searchCache.set(cacheKey, { result, at: Date.now() });

    while (room.searchCache.size > SEARCH_CACHE_MAX_ENTRIES) {
      const oldestKey = room.searchCache.keys().next().value;
      if (oldestKey === undefined) break;
      room.searchCache.delete(oldestKey);
    }

    return result;
  }

  /* ---- phase transitions ---- */

  /**
   * Host-clicked "Start": validates the request, queues the
   * pre-start countdown, and schedules `_doStartLoading` to run
   * once the timer elapses. The room stays in `lobby` for the
   * duration of the countdown — we only flip into `loading` when
   * the timer actually fires (or never, if the host cancels).
   *
   * Idempotent: a duplicate `host:start` while a start is already
   * queued is silently ignored. That keeps a misclicked double-tap
   * from re-arming the timer or pushing the countdown back.
   */
  startLoading(code: string, sessionId: string, mode: unknown): void {
    const room = this.rooms.get(code);
    if (!room) throw new RoomError("ROOM_NOT_FOUND", "Room not found");
    if (room.hostId !== sessionId) throw new RoomError("NOT_HOST", "Only host can start");
    if (room.phase !== "lobby") throw new RoomError("BAD_PHASE", "Not in lobby");
    if (!room.selectedSong) throw new RoomError("NO_SONG", "Pick a song first");
    if (
      mode !== "easy" &&
      mode !== "normal" &&
      mode !== "hard" &&
      mode !== "insane" &&
      mode !== "expert"
    ) {
      throw new RoomError("BAD_MODE", "Invalid difficulty");
    }
    // Already queued — bail without disturbing the existing timer so
    // a double-click can't push the countdown back or re-fire snapshots.
    if (room.prestartEndsAt !== null) return;
    room.prestartMode = mode;
    room.prestartEndsAt = Date.now() + PRESTART_COUNTDOWN_MS;
    if (room.prestartTimer) clearTimeout(room.prestartTimer);
    room.prestartTimer = setTimeout(() => {
      // Re-check liveness: room could have closed (inactivity, all
      // players left) during the 3 s window. Phase could also have
      // changed if some other path forced us out of lobby.
      const fresh = this.rooms.get(code);
      if (!fresh || fresh.phase !== "lobby") return;
      if (fresh.prestartEndsAt === null) return; // cancelled
      const queuedMode = fresh.prestartMode;
      fresh.prestartTimer = null;
      fresh.prestartEndsAt = null;
      fresh.prestartMode = null;
      try {
        this._doStartLoading(fresh, queuedMode ?? "easy");
      } catch {
        // _doStartLoading throws if the song was cleared or some other
        // pre-condition fell through during the countdown; in that case
        // we just bounce back to a clean lobby snapshot so the overlay
        // collapses everywhere.
        this.emitSnapshot(code);
      }
    }, PRESTART_COUNTDOWN_MS);
    this.emitSnapshot(code);
  }

  /**
   * Host-only: cancel a queued (pre-start) match before the loading
   * phase begins. Clears the prestart timer + fields, broadcasts a
   * fresh snapshot so every client's overlay collapses, and emits a
   * "Match cancelled" notice. No-op if no start is queued.
   */
  cancelStart(code: string, sessionId: string): void {
    const room = this.rooms.get(code);
    if (!room) return;
    if (room.hostId !== sessionId) {
      throw new RoomError("NOT_HOST", "Only host can cancel start");
    }
    if (room.prestartEndsAt === null) return;
    if (room.prestartTimer) {
      clearTimeout(room.prestartTimer);
      room.prestartTimer = null;
    }
    room.prestartEndsAt = null;
    room.prestartMode = null;
    this.emitNotice(code, "info", "Match cancelled");
    this.emitSnapshot(code);
  }

  /**
   * Internal: actually flip the room into the loading phase. Runs
   * either at the end of the prestart countdown timer (the normal
   * path) or directly from any future fast-path that wants to skip
   * the countdown. Assumes the caller already validated host + lobby
   * phase + selectedSong + mode.
   */
  private _doStartLoading(room: InternalRoom, mode: ChartMode): void {
    if (room.phase !== "lobby") throw new RoomError("BAD_PHASE", "Not in lobby");
    if (!room.selectedSong) throw new RoomError("NO_SONG", "Pick a song first");
    const code = room.code;
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
      // Pull every CONNECTED player into the match. Disconnected
      // slots (still alive within their TTL) keep their previous
      // value — if they were `inMatch=true` from a prior round
      // they'd reconnect into the loading screen, but practically
      // we just reset both rounds back to a clean false→true
      // transition for everyone here. Players who join AFTER this
      // point land at `inMatch=false` (joinRoom default), which
      // routes them to the lobby with a "match in progress"
      // indicator.
      p.inMatch = p.socketId !== null;
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

  /**
   * Host-only: pause an in-progress match. Stamps `room.pausedAt` with
   * the current wall clock so every client snapshot reconciles to the
   * paused state on its next render, and clears the match safety
   * timer so it doesn't fire mid-pause (it would otherwise treat the
   * paused window as elapsed song time and force-flip to results).
   *
   * Idempotent: a double-press of the Pause button or a stale ack
   * arriving after the host already paused is silently dropped so we
   * don't blow away the original `pausedAt` timestamp (which would
   * shorten the post-resume `songStartedAt` shift and produce a
   * jump in chart position).
   */
  pauseMatch(code: string, sessionId: string): void {
    const room = this.rooms.get(code);
    if (!room) return;
    if (room.hostId !== sessionId) {
      throw new RoomError("NOT_HOST", "Only host can pause");
    }
    if (room.phase !== "playing") return;
    if (room.pausedAt !== null) return;
    room.pausedAt = Date.now();
    // Clear the safety net for the duration of the pause. We re-arm
    // it inside `resumeMatch` after shifting `songStartedAt`, so the
    // remaining-song math comes out right whether the pause lasts
    // 2 seconds or 20 minutes.
    this.clearMatchSafetyTimer(room);
    this.emitNotice(code, "info", "Host paused the match");
    this.emitSnapshot(code);
  }

  /**
   * Host-only: resume a paused match. Adds the elapsed pause duration
   * to `songStartedAt` so:
   *   - The match safety timer (which uses `Date.now() - songStartedAt`
   *     to compute remaining song time) lands at the correct
   *     wall-clock deadline post-resume.
   *   - Late joiners that arrive after the pause compute the right
   *     seek offset on their schedule effect (`now - songStartedAt`
   *     yields the chart position everyone else is at, since their
   *     locally-suspended AudioContexts froze for the same window).
   * Existing connected clients don't need any timestamp adjustment —
   * their `audio.resume()` call un-suspends an AudioContext that
   * froze `ctx.currentTime`, so `songTime()` continues seamlessly.
   *
   * Idempotent: silently returns if not currently paused.
   */
  resumeMatch(code: string, sessionId: string): void {
    const room = this.rooms.get(code);
    if (!room) return;
    if (room.hostId !== sessionId) {
      throw new RoomError("NOT_HOST", "Only host can resume");
    }
    if (room.phase !== "playing") return;
    if (room.pausedAt === null) return;
    const pauseDuration = Date.now() - room.pausedAt;
    if (room.songStartedAt !== null) {
      room.songStartedAt += pauseDuration;
    }
    room.pausedAt = null;
    this.armMatchSafetyTimer(room);
    this.emitNotice(code, "info", "Host resumed the match");
    this.emitSnapshot(code);
  }

  /**
   * Host-only: hard-cancel an in-progress (countdown / playing /
   * paused) match and bounce everyone back to the lobby. No standings
   * are recorded — players see the lobby, not the results screen.
   *
   * Lives alongside `cancelLoading` (loading-phase escape hatch) and
   * `hostReturnToLobby` (results-phase escape hatch); together they
   * give the host a kill switch from every active phase. Intended UI
   * surface is the host's in-game pause menu.
   */
  cancelMatch(code: string, sessionId: string): void {
    const room = this.rooms.get(code);
    if (!room) return;
    if (room.hostId !== sessionId) {
      throw new RoomError("NOT_HOST", "Only host can cancel");
    }
    if (
      room.phase !== "playing" &&
      room.phase !== "countdown" &&
      room.phase !== "loading"
    ) {
      return;
    }
    this.emitNotice(code, "info", "Host cancelled the match");
    this.transitionToLobby(room);
  }

  /**
   * Per-player "leave the active match and sit in the lobby". Flips
   * `players[sessionId].inMatch` to false; the client routing on the
   * next snapshot then takes the player from the match UI back to
   * the Lobby (which renders a "match in progress" indicator while
   * the rest of the room keeps playing).
   *
   * Idempotent and safe to call from any phase — only does anything
   * useful while the room is past the lobby. The host is NOT allowed
   * to leave their own match this way (they'd orphan the room
   * controls); they have to use `host:cancelMatch` to wind it down.
   *
   * Score state is left intact in case the player rejoins later via
   * a future "rejoin match" affordance; for now there's no way back
   * in until the next round starts.
   */
  leaveMatch(code: string, sessionId: string): void {
    const room = this.rooms.get(code);
    if (!room) return;
    // Lobby is a no-op (everyone's already in lobby). Results phase
    // also no-ops — at that point the participant should be on the
    // results screen, and a "leave" button there already exists via
    // the "back to lobby" CTA which transitions the whole room.
    if (
      room.phase !== "loading" &&
      room.phase !== "countdown" &&
      room.phase !== "playing"
    ) {
      return;
    }
    if (room.hostId === sessionId) {
      // Hosts have a different escape hatch — cancelMatch — that
      // ends the match for everyone instead of orphaning the room
      // with no host in it.
      throw new RoomError(
        "HOST_CANT_LEAVE",
        "Host can't leave the match — cancel it instead",
      );
    }
    const p = room.players.get(sessionId);
    if (!p) return;
    if (!p.inMatch) return;
    p.inMatch = false;
    // Their `live` row stays on the scoreboard so the lobby's
    // compact scoreboard for late-joiners + leavers still reflects
    // who was in the match (and the client can grey-out the row
    // visually if it wants). We do NOT zero `live` here — that
    // happens on the next `transitionToLobby`.
    this.emitSnapshot(code);
    // Re-check the gates: if this player was the lone hold-out
    // (e.g. 3-of-3 ready in loading, or 2-of-3 finished in playing
    // and they were the missing one), removing them from the
    // participant set should immediately advance the match. Without
    // this we'd sit on the loading screen / wait for the safety
    // timer until the full grace window elapsed even though the
    // remaining players already converged.
    if (room.phase === "loading") this.checkAllReady(room);
    else if (room.phase === "playing") this.checkAllFinished(room);
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
    // Only emit the load-failed notice while we're actually in the
    // loading phase. The client effect runs in async `.then()/.catch()`
    // chains that resolve *after* the phase may have flipped to
    // countdown, playing, results, or even back to lobby — for slow
    // loaders that's exactly the late-join path. Without this guard a
    // straggler whose download finally errored 40s after the song
    // already started would emit a misleading room-wide "couldn't
    // load" toast in the middle of an active match.
    if (room.phase !== "loading") return;
    const p = room.players.get(sessionId);
    if (!p) return;
    this.emitNotice(
      code,
      "loadFailed",
      `${p.name || "someone"} couldn't load: ${reason}`,
    );
  }

  private checkAllReady(room: InternalRoom): void {
    // Only count match participants — late-joiners (`inMatch=false`)
    // never run the loading screen and so never call `client:ready`,
    // so including them would keep the all-ready gate permanently
    // stuck and force the loading deadline to expire on every round
    // that has a watcher in the lobby.
    const participants = [...room.players.values()].filter(
      (p) => p.socketId !== null && p.inMatch,
    );
    if (participants.length === 0) return;
    if (participants.every((p) => p.ready)) this.tryStartCountdown(room, false);
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
    if (room.countdownTimer) {
      clearTimeout(room.countdownTimer);
      room.countdownTimer = null;
    }
    room.countdownTimer = setTimeout(() => {
      room.countdownTimer = null;
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
      // client:finished packet" still produces a results screen.
      this.armMatchSafetyTimer(room);
    }, delay);
  }

  /**
   * Schedule (or re-schedule) the per-room safety net that guarantees a
   * "results" transition even if no `client:finished` event ever
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
   * `client:finished` keep their authoritative `final` untouched.
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
    // Drop score updates while the host has the match paused. Honest
    // clients won't emit during a pause anyway (their AudioContext is
    // suspended, so songTime() — and therefore the score signature —
    // freezes), but a hostile or out-of-sync client could keep sending
    // and pollute the scoreboard while the room is frozen. Resuming
    // re-opens the gate without any extra work.
    if (room.pausedAt !== null) return;
    const p = room.players.get(sessionId);
    if (!p) return;
    // Anti-spoof: late-joiners + leavers (`inMatch=false`) sit in the
    // lobby with the match-in-progress indicator and have NO running
    // chart; any score update from them is either stale (from a
    // previous round before they left) or a forged packet trying to
    // muscle into the scoreboard. Honest clients gate `client:scoreUpdate`
    // on `me.inMatch && phase === "playing"` so this guard is just
    // belt-and-braces against a tampered build.
    if (!p.inMatch) return;
    // Per-player rate limit. The honest client throttles to 5 Hz
    // (~200 ms cadence — see `MultiGame.tsx` `lastScoreSentSigRef`),
    // so a 100 ms floor still admits real traffic with jitter
    // headroom while silently dropping a malicious flood. Without
    // this gate, a hostile client could fire `client:scoreUpdate`
    // tens of thousands of times per second; each call mutates
    // `p.live` and arms `scheduleScoreboard`, which is cheap
    // individually but adds up to real CPU + per-frame allocator
    // pressure on the room's broadcast tick.
    const now = Date.now();
    if (now - p.lastScoreUpdateAt < SCORE_UPDATE_MIN_INTERVAL_MS) return;
    p.lastScoreUpdateAt = now;
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
    // Same reasoning as `applyScoreUpdate`: while the match is paused
    // the audio clock is frozen everywhere, so an honest client can't
    // legitimately reach end-of-song. Reject finished payloads during
    // pause to deny a hostile client the ability to lock in a
    // pre-baked `final` while everyone else is on hold.
    if (room.pausedAt !== null) return;
    const p = room.players.get(sessionId);
    if (!p) return;
    // Same anti-spoof guard as `applyScoreUpdate`. Late-joiners +
    // leavers can't legitimately reach end-of-song — they aren't
    // even running the chart locally.
    if (!p.inMatch) return;
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
    // Only count match participants — late-joiners + leavers
    // (`inMatch=false`) are sitting in the lobby with the
    // match-in-progress indicator and never submit a `final` payload,
    // so including them would leave the gate permanently open and
    // force the safety timer to be the only path to results.
    const participants = [...room.players.values()].filter(
      (p) => p.socketId !== null && p.inMatch,
    );
    if (participants.length === 0) return;
    if (participants.every((p) => p.final !== null)) this.transitionToResults(room);
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
    // Also drop any pending countdown→playing flip. Without this, a
    // mid-countdown bounce-to-lobby (host cancel, all players leave
    // and reconnect, etc.) would still queue the deferred "phase:
    // playing" emit; it's a no-op (the callback short-circuits on
    // `phase !== "countdown"`), but cancelling here avoids a spurious
    // `phase:playing` race in pathological reorder scenarios.
    if (room.countdownTimer) {
      clearTimeout(room.countdownTimer);
      room.countdownTimer = null;
    }
    // Drop any queued (pre-start) match too. `_doStartLoading` already
    // cleared these on the natural path, but a forced `transitionToLobby`
    // (kicks, host disconnect, all-leave, host:cancelMatch from countdown)
    // could land here mid-prestart and would otherwise leave a stray
    // timer that fires later and tries to flip a non-lobby room.
    if (room.prestartTimer) {
      clearTimeout(room.prestartTimer);
      room.prestartTimer = null;
    }
    room.prestartEndsAt = null;
    room.prestartMode = null;
    room.phase = "lobby";
    // `selectedMode` is cleared so the host's next tap on a difficulty
    // button re-fires `host:setMode` and the server doesn't carry a
    // stale mode hint into the new round.
    room.selectedMode = null;
    room.startsAt = null;
    room.songStartedAt = null;
    // Drop any leftover pause state. A `cancelMatch` from the host's
    // pause menu lands here while `pausedAt` is non-null; clearing
    // it ensures the next round starts with a clean baseline and the
    // lobby snapshot doesn't leak a stale "paused" signal back to
    // clients that might still mis-interpret it.
    room.pausedAt = null;
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
      // Lobby phase has no notion of "in match"; clear so the next
      // `startLoading` starts everyone from a clean false→true
      // transition. Late-joiners during the prior round (who were
      // already at false) are unaffected.
      p.inMatch = false;
    }
    this.io.to(`room:${room.code}`).emit("phase:lobby");
    this.emitSnapshot(room.code);
  }

  refOf(socketId: string) {
    return this.socketIndex.get(socketId);
  }

  isHostSession(code: string, sessionId: string): boolean {
    const room = this.rooms.get(code);
    if (!room) return false;
    return room.hostId === sessionId;
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
        // Host-only: the catalog drives the song picker, which is
        // exclusively a host UI. Without this gate any guest could
        // fire `host:catalogRequest` (especially with `refresh: true`)
        // and force the server to repeatedly hit the upstream osu!
        // mirrors, ignoring the in-memory cache. Mirrors aren't
        // rate-limit-friendly, so a single noisy guest could earn the
        // room a 429 from `nerinyan.moe` / `osu.direct` /
        // `catboy.best` and brick song selection for everyone.
        if (!reg.isHostSession(ref.code, ref.sessionId)) {
          throw new RoomError("NOT_HOST", "Only the host can browse the catalog");
        }
        const items = await reg.ensureCatalog(ref.code, !!payload?.refresh);
        ack?.(ackOk({ items }));
      } catch (e) {
        ack?.(ackErr(e));
      }
    });

    socket.on("host:catalogBrowse", async (payload, ack) => {
      try {
        const ref = reg.refOf(socket.id);
        if (!ref) throw new RoomError("NOT_IN_ROOM", "Not in a room");
        // Same host-only gate as `host:catalogRequest` /
        // `host:catalogSearch` — every browse page that misses the
        // cache hits a real mirror, so guests must not be able to
        // trigger them or they could exhaust the room's mirror
        // quota with a tight loop.
        if (!reg.isHostSession(ref.code, ref.sessionId)) {
          throw new RoomError("NOT_HOST", "Only the host can browse the catalog");
        }
        const page = Number(payload?.page ?? 0);
        if (!Number.isFinite(page) || page < 0) {
          throw new RoomError("BAD_PAGE", "Invalid page index");
        }
        const result = await reg.browseCatalog(
          ref.code,
          typeof payload?.sort === "string" ? payload.sort : undefined,
          page,
          !!payload?.refresh,
        );
        ack?.(
          ackOk({
            items: result.items,
            page: result.page,
            sort: ((BROWSE_SORT_VALUES as readonly string[]).includes(
              (payload?.sort as string) ?? "",
            )
              ? (payload!.sort as string)
              : "ranked_desc"),
            hasMore: result.hasMore,
            source: result.source,
          }),
        );
      } catch (e) {
        ack?.(ackErr(e));
      }
    });

    socket.on("host:catalogSearch", async (payload, ack) => {
      try {
        const ref = reg.refOf(socket.id);
        if (!ref) throw new RoomError("NOT_IN_ROOM", "Not in a room");
        // Same host-only gate as `host:catalogRequest`. Each search call
        // hits a real mirror (after the per-room LRU cache misses), so
        // letting guests trigger searches would be a trivial way to
        // exhaust the room's mirror quota.
        if (!reg.isHostSession(ref.code, ref.sessionId)) {
          throw new RoomError("NOT_HOST", "Only the host can search the catalog");
        }
        const query = String(payload?.query ?? "");
        const page = Number(payload?.page ?? 0);
        if (!Number.isFinite(page) || page < 0) {
          throw new RoomError("BAD_PAGE", "Invalid page index");
        }
        const result = await reg.searchCatalog(ref.code, query, page);
        ack?.(
          ackOk({
            items: result.items,
            page: result.page,
            // Echo the normalized query back so the client can detect
            // out-of-order responses (debounced typing → multiple
            // in-flight requests; only the latest matters).
            query: query.trim().toLowerCase().replace(/\s+/g, " "),
            hasMore: result.hasMore,
            source: result.source,
          }),
        );
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

    socket.on("host:cancelStart", () => {
      const ref = reg.refOf(socket.id);
      if (!ref) return;
      try {
        reg.cancelStart(ref.code, ref.sessionId);
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

    /* ---- in-match host controls (pause / resume / cancel) ---- */
    //
    // All three guard themselves at the registry level (host check +
    // phase check + paused-state check). The socket wrappers stay
    // thin so a malformed event from a guest just bounces back as
    // an "error" toast without mutating any room state.

    socket.on("host:pauseMatch", () => {
      const ref = reg.refOf(socket.id);
      if (!ref) return;
      try {
        reg.pauseMatch(ref.code, ref.sessionId);
      } catch (e) {
        socket.emit("error", ackErr(e) as unknown as { code: string; message: string });
      }
    });

    socket.on("host:resumeMatch", () => {
      const ref = reg.refOf(socket.id);
      if (!ref) return;
      try {
        reg.resumeMatch(ref.code, ref.sessionId);
      } catch (e) {
        socket.emit("error", ackErr(e) as unknown as { code: string; message: string });
      }
    });

    socket.on("host:cancelMatch", () => {
      const ref = reg.refOf(socket.id);
      if (!ref) return;
      try {
        reg.cancelMatch(ref.code, ref.sessionId);
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

    /* ---- leave the active match (non-host participant) ---- */

    socket.on("room:leaveMatch", () => {
      const ref = reg.refOf(socket.id);
      if (!ref) return;
      try {
        reg.leaveMatch(ref.code, ref.sessionId);
      } catch (e) {
        socket.emit("error", ackErr(e) as unknown as { code: string; message: string });
      }
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
