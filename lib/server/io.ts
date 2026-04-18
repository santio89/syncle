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
  ClientToServerEvents,
  FinalStats,
  LiveScore,
  MAX_PLAYERS_PER_ROOM,
  NoticeKind,
  PlayerSnapshot,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  RoomPhase,
  RoomSnapshot,
  ScoreboardEntry,
  ServerToClientEvents,
  SongRef,
  Standing,
  isValidRoomCode,
  sanitizeName,
} from "@/lib/multi/protocol";
import { fetchCatalog } from "./catalog";

/* -------------------------------------------------------------------------- */
/* Tunables                                                                   */
/* -------------------------------------------------------------------------- */

/** How long a disconnected player keeps their slot before eviction. */
const PLAYER_GRACE_MS = 60_000;
/** How long a fully-empty room sticks around for refresh-rejoin. */
const EMPTY_ROOM_TTL_MS = 10 * 60_000;
/** Max wait for everyone to call `client:ready` after host hits start. */
const LOADING_DEADLINE_MS = 30_000;
/** Grace between "everyone ready" and the wall-clock t0 for audio. */
const COUNTDOWN_LEAD_MS = 4_000;
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
  live: LiveScore;
  final: FinalStats | null;
  postChoice: "stay" | "leave" | null;
  graceTimer: NodeJS.Timeout | null;
}

interface InternalRoom {
  code: string;
  createdAt: number;
  hostId: string;
  phase: RoomPhase;
  players: Map<string, InternalPlayer>;
  selectedSong: SongRef | null;
  selectedMode: ChartMode | null;
  startsAt: number | null;
  songStartedAt: number | null;
  catalog: CatalogItem[] | null;
  catalogFetchedAt: number | null;
  emptyTtlTimer: NodeJS.Timeout | null;
  loadingTimer: NodeJS.Timeout | null;
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
    health: 1,
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
    this.io.to(`room:${code}`).emit("room:snapshot", this.snapshotOf(room));
  }

  emitNotice(code: string, kind: NoticeKind, text: string): void {
    this.io.to(`room:${code}`).emit("room:notice", { kind, text });
  }

  emitScoreboard(code: string): void {
    const room = this.rooms.get(code);
    if (!room) return;
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
        live: p.live,
        final: p.final,
        postChoice: p.postChoice,
      });
    }
    players.sort((a, b) => a.joinedAt - b.joinedAt);
    return {
      code: room.code,
      hostId: room.hostId,
      phase: room.phase,
      selectedSong: room.selectedSong,
      startsAt: room.startsAt,
      songStartedAt: room.songStartedAt,
      players,
    };
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

  createRoom(socketId: string, name: string): { code: string; sessionId: string } {
    const code = this.generateCode();
    const sessionId = randomUUID();
    const room: InternalRoom = {
      code,
      createdAt: Date.now(),
      hostId: sessionId,
      phase: "lobby",
      players: new Map(),
      selectedSong: null,
      selectedMode: null,
      startsAt: null,
      songStartedAt: null,
      catalog: null,
      catalogFetchedAt: null,
      emptyTtlTimer: null,
      loadingTimer: null,
    };
    room.players.set(sessionId, {
      id: sessionId,
      socketId,
      name,
      isHost: true,
      joinedAt: Date.now(),
      ready: false,
      live: emptyLive(),
      final: null,
      postChoice: null,
      graceTimer: null,
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
      live: emptyLive(),
      final: null,
      postChoice: null,
      graceTimer: null,
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
    if (p.graceTimer) {
      clearTimeout(p.graceTimer);
      p.graceTimer = null;
    }
    p.socketId = socketId;
    this.socketIndex.set(socketId, { code, sessionId });
    return p;
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
    return { room, player: p };
  }

  evict(code: string, sessionId: string, reason: "leave" | "grace"): void {
    const room = this.rooms.get(code);
    if (!room) return;
    const p = room.players.get(sessionId);
    if (!p) return;
    if (p.graceTimer) clearTimeout(p.graceTimer);
    room.players.delete(sessionId);
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
      if (room.players.size === 0) this.rooms.delete(room.code);
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
    room.selectedSong = {
      beatmapsetId: s.beatmapsetId,
      title: String(s.title ?? "Untitled").slice(0, 80),
      artist: String(s.artist ?? "Unknown").slice(0, 80),
      source: String(s.source ?? "host").slice(0, 32),
    };
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
      this.io
        .to(`room:${room.code}`)
        .emit("phase:playing", { songStartedAt: room.songStartedAt });
      this.emitSnapshot(room.code);
    }, delay);
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
    if (room.phase !== "playing" && room.phase !== "countdown") return;
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
    const leavers: string[] = [];
    for (const p of room.players.values()) {
      if (p.postChoice === "leave") leavers.push(p.id);
    }
    for (const id of leavers) this.evict(code, id, "leave");
    const fresh = this.rooms.get(code);
    if (!fresh) return;
    this.transitionToLobby(fresh);
  }

  private transitionToLobby(room: InternalRoom): void {
    if (room.loadingTimer) {
      clearTimeout(room.loadingTimer);
      room.loadingTimer = null;
    }
    room.phase = "lobby";
    room.selectedMode = null;
    room.startsAt = null;
    room.songStartedAt = null;
    for (const p of room.players.values()) {
      p.ready = false;
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
        const name = sanitizeName(payload?.name) || "Player";
        const { code, sessionId } = reg.createRoom(socket.id, name);
        socket.join(`room:${code}`);
        ack?.(ackOk({ code, sessionId }));
        reg.emitSnapshot(code);
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
