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

/**
 * Room visibility:
 *   - "public":  shows up in the room browser, anyone with the URL can join
 *   - "private": code-only — never appears in the public listing
 *
 * Both flavors still use the same 6-char code internally; the distinction
 * is purely about discoverability. Mirrors the public/private convention
 * from arena shooters of the early-2000s era (Quake, Half-Life).
 */
export type RoomVisibility = "public" | "private";

export interface SongRef {
  beatmapsetId: number;
  title: string;
  artist: string;
  /** Which mirror search returned this entry. Diagnostic only. */
  source: string;
  /**
   * Track duration in WHOLE seconds. Optional because the field was
   * added after launch — old servers, manually-crafted SongRefs, and
   * cached snapshots may omit it. Sourced from the longest 4K mania
   * difficulty's `total_length` in the search-mirror response, which
   * matches what the audio engine reports once the .osz is decoded.
   * Used by the host song picker to show "3:42" instead of the
   * mirror name in the right column of every catalog row.
   */
  durationSec?: number;
}

export interface CatalogItem extends SongRef {}

/**
 * Single chat line, broadcast to everyone in the room. Authored on the
 * server (sets `at` and `id`) so clients can't spoof timestamps and
 * IDs are guaranteed unique for React keying.
 *
 * `kind`:
 *   - "user"   → player-authored message (most chat lines)
 *   - "system" → server-authored notice rendered inline in chat
 *                (e.g. "Alice was kicked", "Bob is now host"). Uses the
 *                chat stream so the room narrative is in one place
 *                instead of scattered across notices + chat.
 */
export interface ChatMessage {
  id: number;
  at: number;
  kind: "user" | "system";
  /** sessionId of author; "" for system messages. */
  authorId: string;
  /** Display name snapshot at send time (so renames don't rewrite history). */
  authorName: string;
  text: string;
}

/**
 * Compact summary of a public room used by the browser listing. Keeping
 * this distinct from RoomSnapshot lets the server fan out lightweight
 * payloads to "lobby browsers" without leaking per-player state.
 */
export interface PublicRoomEntry {
  code: string;
  name: string;
  hostName: string;
  playerCount: number;
  maxPlayers: number;
  phase: RoomPhase;
  /** Title — artist of the currently selected song, if any. */
  selectedSong: string | null;
  createdAt: number;
}

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
  /**
   * Lobby-level "I'm ready to play whatever the host picks" flag.
   * Distinct from `ready` (which is the per-round "chart downloaded +
   * decoded" state). Purely an informational signal to the host so
   * they can see how many players are willing to start; the server
   * does NOT auto-start on all-ready (that would surprise the host
   * mid-conversation). The host always has to click "Start match"
   * themselves — see `setLobbyReady` in `lib/server/io.ts` for the
   * deliberate no-op around auto-start.
   */
  lobbyReady: boolean;
  /**
   * Host-set silence flag. Muted players are still visible in the
   * roster and can play, but the server drops their `chat:send`
   * payloads silently. Surfaces in the UI as a strikethrough on the
   * chat input + a "muted" pill in the roster row.
   */
  muted: boolean;
  /** Live score during the playing phase. Reset between rounds. */
  live: LiveScore;
  /** Set once the player submits final stats at end of song. */
  final: FinalStats | null;
  /** Post-results choice. null → undecided. */
  postChoice: "stay" | "leave" | null;
  /**
   * Whether this player is participating in the active match (or
   * sitting in the lobby watching). Drives client-side routing
   * during `loading` / `countdown` / `playing` / `results`:
   *
   *   - `inMatch === true`  → render the match UI (LoadingScreen,
   *     MultiGame canvas, ResultsScreen).
   *   - `inMatch === false` → render the Lobby with a "match in
   *     progress" indicator + compact live scoreboard. This is the
   *     state for late-joiners (joined via `room:join` after the
   *     host already started) and for players who left mid-match
   *     via `room:leaveMatch`.
   *
   * Always `false` while the room is in the lobby phase (everyone
   * is in lobby; the flag is only meaningful during a match). Set
   * to `true` for every connected player on `startLoading`. Reset
   * to `false` for everyone on `transitionToLobby`. Survives
   * disconnect/reconnect inside the slot TTL — that's how a
   * mid-song refresh continues the run instead of dropping the
   * player into the lobby.
   */
  inMatch: boolean;
}

export interface RoomSnapshot {
  code: string;
  /** Host-chosen room title shown in the browser + lobby header. */
  name: string;
  /** Discoverability — see RoomVisibility doc. */
  visibility: RoomVisibility;
  hostId: string;
  phase: RoomPhase;
  selectedSong: SongRef | null;
  /**
   * Host-chosen difficulty for the current run. Mirrored on every
   * snapshot (in addition to being announced via the one-shot
   * `phase:loading` event) so a client that reconnects mid-game has
   * enough state to refetch the same chart instead of falling back to
   * "easy". Null while the host is still picking in the lobby.
   */
  selectedMode: ChartMode | null;
  /** Wall-clock ms when audio is supposed to start (countdown phase only). */
  startsAt: number | null;
  /**
   * Wall-clock ms when audio actually started (playing/results phases).
   *
   * Pause-aware: when the host pauses an in-progress match, the server
   * adds the pause duration to this value on resume. This way late
   * joiners (or any client recomputing the seek offset on the
   * countdown→playing schedule effect) compute `now - songStartedAt`
   * and land on the same chart position as everyone else, even after
   * arbitrary pause / resume cycles.
   */
  songStartedAt: number | null;
  /**
   * Wall-clock ms when the host paused an in-progress match. `null`
   * while the match is running. Set to `Date.now()` by `host:pauseMatch`
   * during the `playing` phase; cleared by `host:resumeMatch`. Drives
   * the per-client `audio.pause()` / `audio.resume()` toggle and the
   * room-wide "PAUSED — waiting for host" overlay; also frozen on the
   * scoreboard so peer scores don't churn while play is suspended.
   */
  pausedAt: number | null;
  players: PlayerSnapshot[];
  /** Rolling chat backlog (server-trimmed to MAX_CHAT_HISTORY). */
  chat: ChatMessage[];
}

/* -------------------------------------------------------------------------- */
/* Client → server events                                                     */
/* -------------------------------------------------------------------------- */

export interface ClientToServerEvents {
  /**
   * Open a fresh room.
   *
   * Payload fields:
   *   - `name`        → display name of the room (shown in browser + header)
   *   - `displayName` → the creating player's nickname
   *   - `visibility`  → public/private (defaults to "private" server-side
   *                     if missing for backwards-compat).
   */
  "room:create": (
    payload: {
      name?: string;
      displayName: string;
      visibility?: RoomVisibility;
    },
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

  /**
   * Toggle this player's lobby-ready flag. Allowed in the lobby phase
   * only (silently ignored otherwise). Purely advisory: the server
   * does NOT auto-start on all-ready — the host always clicks "Start
   * match" themselves. See `PlayerSnapshot.lobbyReady` for the
   * rationale (we intentionally don't surprise the host mid-chat).
   */
  "room:setReady": (payload: { ready: boolean }) => void;

  /**
   * Any player can send everyone back to the lobby from the results
   * screen. The server transitions the whole room and the requester
   * stays in their seat. Players who've already left (router push to
   * /) are evicted on disconnect grace as usual. Idempotent — multiple
   * clicks during the same results phase produce a single transition.
   */
  "room:returnToLobby": () => void;

  /**
   * Any (non-host) participant can sit out the rest of an active
   * match. Server flips `players[me].inMatch = false`, keeps the
   * player in the room, and broadcasts a fresh snapshot. The client
   * re-routes from the match UI to the Lobby (with a "match in
   * progress" indicator) on the next snapshot. Idempotent — calling
   * during lobby/results phases or when already out of the match
   * silently no-ops. Hosts can't leave the match this way; they
   * have to use `host:cancelMatch` to end it for everyone.
   */
  "room:leaveMatch": () => void;

  /**
   * List currently-discoverable public rooms. Returns a snapshot via
   * ack. The browser polls this every few seconds rather than pushing
   * server-side subscriptions, which keeps the lobby UI stateless.
   */
  "rooms:listPublic": (
    payload: Record<string, never>,
    ack: (res: AckResult<{ rooms: PublicRoomEntry[] }>) => void,
  ) => void;

  /**
   * Send a chat message. Server enforces:
   *   - sender is in a room and not muted
   *   - text length ≤ CHAT_MAX_LEN after trim
   *   - rate-limited to CHAT_RATE_LIMIT per CHAT_RATE_WINDOW_MS
   * Rejected messages are silently dropped (no error event) so a
   * spammer can't probe the rate-limiter for timing.
   */
  "chat:send": (payload: { text: string }) => void;

  /**
   * Host-only: rename the room. Same sanitization + length cap as the
   * initial create flow. Empty / whitespace-only payloads are silently
   * ignored (the server keeps the previous name) so a misclick can't
   * blank out the title in the public browser. Broadcasts a fresh
   * snapshot so every client's lobby header updates in lockstep.
   */
  "host:setRoomName": (payload: { name: string }) => void;

  /**
   * Host-only: flip the room between public (appears in the browser)
   * and private (only joinable via code). Rejected silently if the
   * payload is malformed or the room is already in the requested state
   * (no snapshot churn for a no-op). Broadcasts a fresh snapshot so
   * remote clients see their visibility pill update in real time AND
   * so the public browser refresh-poll picks up the change on its next
   * tick.
   */
  "host:setVisibility": (payload: { visibility: RoomVisibility }) => void;

  /** Host-only: kick a player out of the room. Cannot kick yourself. */
  "host:kick": (payload: { sessionId: string }) => void;

  /** Host-only: silence a player's chat. Toggle-style. */
  "host:mute": (payload: { sessionId: string; muted: boolean }) => void;

  /** Host-only: ask the server for a fresh page of catalog candidates. */
  "host:catalogRequest": (
    payload: { refresh?: boolean },
    ack: (res: AckResult<{ items: CatalogItem[] }>) => void,
  ) => void;

  /** Host-only: announce the chosen song to the room (lobby phase). */
  "host:selectSong": (payload: SongRef) => void;

  /**
   * Host-only: continuously track which difficulty the host has
   * selected in their picker, so the server can fire the right
   * `startLoading` when the room hits the "all ready" quorum without
   * the host clicking anything. Sent on every difficulty button tap;
   * cheap (~30 bytes) and idempotent (server stores latest).
   */
  "host:setMode": (payload: { mode: ChartMode }) => void;

  /**
   * Host-only: kick the room into the loading phase. Server then waits for
   * every player's `client:ready` (or a 30s timeout) before transitioning
   * to countdown.
   */
  "host:start": (payload: { mode: ChartMode }) => void;

  /** Host-only: cancel an in-progress loading phase, return to lobby. */
  "host:cancelLoading": () => void;

  /**
   * Host-only: pause an in-progress match. Server records `pausedAt`
   * on the room and broadcasts a fresh snapshot; every client
   * (including the host) sees `pausedAt !== null` and calls
   * `audio.pause()` on their AudioEngine. The room-wide pause overlay
   * appears on every screen. No-op outside the `playing` phase or
   * when the match is already paused. Match safety timer is cleared
   * for the duration of the pause; re-armed on resume.
   */
  "host:pauseMatch": () => void;

  /**
   * Host-only: resume a paused match. Server adds the pause duration
   * to `songStartedAt` (so late joiners + the safety timer recompute
   * against the right baseline), clears `pausedAt`, re-arms the
   * safety timer, and broadcasts a fresh snapshot. Every client calls
   * `audio.resume()` on their AudioEngine; existing AudioContexts
   * pick up exactly where they left off (their per-client
   * `startedAtCtxTime` is unchanged because `ctx.currentTime` froze
   * during the suspend, so `songTime()` continues without a jump).
   * No-op when not paused.
   */
  "host:resumeMatch": () => void;

  /**
   * Host-only: end an in-progress (playing / countdown / paused)
   * match early and return everyone to the lobby. Unlike the
   * lobby/results back-to-room flow, this is destructive — no
   * standings are recorded. Used as the "I made a mistake / wrong
   * chart / need to leave" escape hatch from the host's pause menu.
   */
  "host:cancelMatch": () => void;

  /**
   * Host-only: send everyone back to the lobby after results.
   *
   * @deprecated Prefer `room:returnToLobby` which any player can invoke
   * (the user-facing flow is "anyone clicks Back to room → everyone
   * returns"). Kept for backwards compat in case an older client still
   * has it wired; behaves identically.
   */
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
    /**
     * ms wall-clock deadline at which the server force-starts the
     * countdown, even if not everyone is ready yet. Stragglers stay
     * in the room and join late: their client keeps downloading +
     * decoding, then the schedule effect seeks the audio buffer by
     * `now - startsAt` so they slot into the song timeline at the
     * right offset. The server emits a soft "starting without X" notice
     * so the room knows who is hopping in late. If NOBODY is ready by
     * the deadline, the room bounces back to lobby instead.
     */
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

  /**
   * Single new chat message append. Sent immediately on each
   * `chat:send`, in addition to being echoed back into the rolling
   * `RoomSnapshot.chat` array on the next snapshot tick. Clients
   * append-on-event for sub-frame latency, then reconcile with the
   * snapshot for late joiners + de-dup by id.
   */
  "chat:message": (payload: ChatMessage) => void;

  /**
   * Hard kick — the kicked player gets this then their socket leaves
   * the room. Lets the client show a polite "You were kicked from the
   * room" splash before redirecting, instead of looking like a crash.
   */
  "room:kicked": (payload: { reason: string }) => void;

  /** Recoverable error surfaced to the client UI. */
  error: (payload: { code: string; message: string }) => void;
}

export type NoticeKind =
  | "join"
  | "leave"
  | "host"
  | "ready"
  | "loadFailed"
  | "info"
  | "kick"
  | "mute";

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
/** Room display name (shown in browser + lobby header). */
export const ROOM_NAME_MAX_LEN = 40;
/** Single chat message length cap. Tuned to 240 — enough for a sentence
 *  or short reaction without becoming a wall of text in the panel. */
export const CHAT_MAX_LEN = 240;
/** Server keeps the last N chat messages per room and includes them in
 *  snapshots for late joiners + refreshes. 100 ≈ a few minutes of
 *  active conversation, well under any practical bandwidth ceiling. */
export const MAX_CHAT_HISTORY = 100;
/** Per-player chat send rate limit. */
export const CHAT_RATE_LIMIT = 6;
export const CHAT_RATE_WINDOW_MS = 8_000;

/**
 * Per-player minimum interval (ms) between accepted `client:scoreUpdate`
 * packets, server-side. The honest client throttles to 5 Hz (one packet
 * per ~200 ms), so a 100 ms floor still passes legitimate traffic with
 * jitter headroom while silently dropping a malicious flood that would
 * otherwise CPU-tax `applyScoreUpdate` and the per-room scoreboard
 * scheduler. Dropped packets are NOT acked or echoed — the spammer just
 * sees their writes fail to land.
 */
export const SCORE_UPDATE_MIN_INTERVAL_MS = 100;

/* -------------------------------------------------------------------------- */
/* Match start timing                                                         */
/* -------------------------------------------------------------------------- */
/**
 * Visible "3 / 2 / 1" overlay duration. The countdown overlay is what
 * the player actually reads — it should match what they see in solo
 * (3 s) so the muscle memory carries over.
 */
export const MATCH_OVERLAY_MS = 3_000;
/**
 * Silent runway between the overlay disappearing and the song actually
 * starting. The highway scrolls empty during this window so the player
 * has a beat (literally) to settle their hands on the keys before notes
 * start arriving. Matches single-player's `LEAD_IN_SECONDS`.
 */
export const MATCH_LEAD_IN_MS = 2_000;
/**
 * Total wall-clock delay between the server entering the `countdown`
 * phase and the audio actually playing — i.e. how far in the future
 * `room.startsAt` is set. Sum of the visible overlay + the silent
 * runway. Server uses this to schedule its `phase:playing` transition;
 * clients use it to know when to start the audio buffer.
 */
export const MATCH_COUNTDOWN_LEAD_MS = MATCH_OVERLAY_MS + MATCH_LEAD_IN_MS;

/**
 * Server-side safety grace tacked onto the song's expected duration
 * before the room is force-transitioned to "results". The intent is to
 * GUARANTEE a results screen even if a player's `client:finished` event
 * never arrives (chart load failure, frozen tab, lost websocket frame,
 * client crashed mid-song, etc.). Without this grace the room would
 * stay stuck in "playing" forever and nobody — not even players who
 * cleanly finished — would ever see their final standings.
 *
 * 12 s is the budget for: last-note judgment window (~1 s) + a generous
 * round-trip margin for the slowest connected client to send their
 * `client:finished` packet under network congestion. Tuning this lower
 * risks cutting off legitimate finishers; tuning higher makes the
 * results screen feel laggy when one player has flat-out abandoned.
 */
export const MATCH_RESULTS_GRACE_MS = 12_000;
/**
 * Hard fallback for the safety timer when `selectedSong.durationSec`
 * isn't known (older mirror responses, hand-crafted SongRefs). 8 min
 * comfortably exceeds the longest 4K mania charts in the typical osu
 * catalog, so we prefer an over-long fallback over force-cutting a
 * real song mid-play.
 */
export const MATCH_MAX_DURATION_FALLBACK_MS = 8 * 60 * 1_000;

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

/**
 * Same hygiene as sanitizeName but with a longer cap — room titles need
 * room to breathe ("Friday night brain melt" is 22 chars and still
 * tight). Empty string after sanitization → caller picks a fallback
 * (e.g. "$NICKNAME's room").
 */
export function sanitizeRoomName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return raw
    .replace(/[\u0000-\u001f\u007f\u200b-\u200d\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, ROOM_NAME_MAX_LEN);
}

/**
 * Sanitize a chat line. Same control-char strip as the name helpers but
 * we DON'T collapse runs of whitespace because intentional double-spaces
 * (e.g. ASCII art, code snippets) are part of how players express
 * themselves. Newlines are normalized to single \n (multi-line chat
 * rendered with `whitespace-pre-wrap`).
 */
export function sanitizeChatText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f\u200b-\u200d\ufeff]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, CHAT_MAX_LEN);
}
