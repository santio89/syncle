/**
 * Wire protocol shared by the Socket.IO server (`server.mjs` + `lib/server/`)
 * and every browser client. Keep this file 100% type-only — no runtime code,
 * no Node-only imports — so it can be bundled into the browser.
 *
 * Naming conventions:
 *   - `client:*`  → fired by a browser, handled on the server
 *   - `server:*`  → fired by the server, handled by every browser in the room
 *   - All payloads are plain JSON (Socket.IO serializes via JSON by default).
 *
 * Bandwidth budget per player at 50-player rooms, 5 Hz score updates:
 *   ~150 bytes × 5 Hz = 750 B/s in,  fan-out × 50 = ~37 KB/s out per room.
 *   Trivially fine for any host.
 */

import type { ChartMode } from "@/lib/game/chart";

/* -------------------------------------------------------------------------- */
/* Domain types                                                               */
/* -------------------------------------------------------------------------- */

export type RoomPhase = "lobby" | "loading" | "countdown" | "playing" | "results";

export interface SongRef {
  beatmapsetId: number;
  title: string;
  artist: string;
  /** Which mirror search returned this entry. Diagnostic only. */
  source: string;
}

export interface CatalogItem extends SongRef {}

export interface PlayerHits {
  perfect: number;
  great: number;
  good: number;
  miss: number;
}

export interface LiveScore {
  score: number;
  combo: number;
  maxCombo: number;
  accuracy: number;
  notesPlayed: number;
  totalNotes: number;
  hits: PlayerHits;
  health: number;
  finished: boolean;
}

export interface FinalStats {
  score: number;
  accuracy: number;
  maxCombo: number;
  hits: PlayerHits;
  notesPlayed: number;
  totalNotes: number;
}

export interface PlayerSnapshot {
  id: string;
  name: string;
  isHost: boolean;
  /** True when the socket is currently connected. */
  online: boolean;
  /** Joined timestamp (ms). */
  joinedAt: number;
  /** Per-player ready flag during the loading phase. */
  ready: boolean;
  /** Live score during the playing phase. Reset between rounds. */
  live: LiveScore;
  /** Set once the player submits final stats at end of song. */
  final: FinalStats | null;
  /** Post-results choice. null → undecided. */
  postChoice: "stay" | "leave" | null;
}

export interface RoomSnapshot {
  code: string;
  hostId: string;
  phase: RoomPhase;
  selectedSong: SongRef | null;
  /** Wall-clock ms when audio is supposed to start (countdown phase only). */
  startsAt: number | null;
  /** Wall-clock ms when audio actually started (playing/results phases). */
  songStartedAt: number | null;
  players: PlayerSnapshot[];
}

/* -------------------------------------------------------------------------- */
/* Client → server events                                                     */
/* -------------------------------------------------------------------------- */

export interface ClientToServerEvents {
  /** Open a fresh room. Returns code + sessionId via ack. */
  "room:create": (
    payload: { name: string },
    ack: (res: AckResult<{ code: string; sessionId: string }>) => void,
  ) => void;

  /** Join an existing room by code. */
  "room:join": (
    payload: { code: string; name: string; sessionId?: string },
    ack: (res: AckResult<{ code: string; sessionId: string }>) => void,
  ) => void;

  /**
   * Reattach a previously-disconnected socket to its slot. Used after a
   * page refresh / network blip. Must succeed within the per-player TTL
   * (60s default) or the slot is gone.
   */
  "room:rejoin": (
    payload: { code: string; sessionId: string },
    ack: (res: AckResult<{ code: string }>) => void,
  ) => void;

  /** Hard leave — server removes the player and broadcasts. */
  "room:leave": () => void;

  "room:setName": (payload: { name: string }) => void;

  /** Host-only: ask the server for a fresh page of catalog candidates. */
  "host:catalogRequest": (
    payload: { refresh?: boolean },
    ack: (res: AckResult<{ items: CatalogItem[] }>) => void,
  ) => void;

  /** Host-only: announce the chosen song to the room (lobby phase). */
  "host:selectSong": (payload: SongRef) => void;

  /**
   * Host-only: kick the room into the loading phase. Server then waits for
   * every player's `client:ready` (or a 30s timeout) before transitioning
   * to countdown.
   */
  "host:start": (payload: { mode: ChartMode }) => void;

  /** Host-only: cancel an in-progress loading phase, return to lobby. */
  "host:cancelLoading": () => void;

  /** Host-only: send everyone back to the lobby after results. */
  "host:returnToLobby": () => void;

  /** Per-client: chart parsed + audio decoded; ready to start. */
  "client:ready": () => void;

  /** Per-client: failed to load (bad chart, mirror down, etc). */
  "client:loadFailed": (payload: { reason: string }) => void;

  /** Per-client: throttled live score update. Server fans out to room. */
  "client:scoreUpdate": (payload: LiveScore) => void;

  /** Per-client: song finished, here are my final stats. */
  "client:finished": (payload: FinalStats) => void;

  /** Per-client: post-results decision. */
  "client:choice": (payload: { choice: "stay" | "leave" }) => void;
}

/* -------------------------------------------------------------------------- */
/* Server → client events                                                     */
/* -------------------------------------------------------------------------- */

export interface ServerToClientEvents {
  /** Sent on join/rejoin and any time the structural state changes. */
  "room:snapshot": (snap: RoomSnapshot) => void;

  /** Cheap broadcast used at high tick rates (5 Hz scoreboard updates). */
  "room:scoreboard": (payload: ScoreboardEntry[]) => void;

  /** Phase transitions broken out for ergonomics — clients can also infer
   *  these from snapshot.phase changes, but explicit events are nicer. */
  "phase:lobby": () => void;
  "phase:loading": (payload: {
    song: SongRef;
    mode: ChartMode;
    /** ms wall-clock deadline by which everyone must be ready. */
    deadline: number;
  }) => void;
  "phase:countdown": (payload: {
    /** Wall-clock ms when audio should begin playing. */
    startsAt: number;
  }) => void;
  "phase:playing": (payload: {
    /** Wall-clock ms when audio actually started. Late joiners use this
     *  to compute their seek offset when resuming a run. */
    songStartedAt: number;
  }) => void;
  "phase:results": (payload: {
    standings: Standing[];
    winnerId: string;
  }) => void;

  /** A toast-style notification (e.g. "Alice joined", "Bob is loading…"). */
  "room:notice": (payload: { kind: NoticeKind; text: string }) => void;

  /** Recoverable error surfaced to the client UI. */
  error: (payload: { code: string; message: string }) => void;
}

export type NoticeKind =
  | "join"
  | "leave"
  | "host"
  | "ready"
  | "loadFailed"
  | "info";

export interface ScoreboardEntry {
  id: string;
  name: string;
  score: number;
  combo: number;
  accuracy: number;
  online: boolean;
  finished: boolean;
}

export interface Standing {
  id: string;
  name: string;
  score: number;
  accuracy: number;
  maxCombo: number;
  rank: number;
  online: boolean;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

export type AckResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string };

/** 6-char A-Z 0-9 code, no ambiguous chars (no 0/O/1/I). */
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const ROOM_CODE_LENGTH = 6;
export const MAX_PLAYERS_PER_ROOM = 50;
export const NAME_MAX_LEN = 20;

export function isValidRoomCode(code: string): boolean {
  if (typeof code !== "string") return false;
  if (code.length !== ROOM_CODE_LENGTH) return false;
  for (const ch of code) {
    if (!ROOM_CODE_ALPHABET.includes(ch)) return false;
  }
  return true;
}

export function sanitizeName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  // Strip controls + zero-width chars; collapse whitespace; trim length.
  // eslint-disable-next-line no-control-regex
  return raw
    .replace(/[\u0000-\u001f\u007f\u200b-\u200d\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NAME_MAX_LEN);
}
