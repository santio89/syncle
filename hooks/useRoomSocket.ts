"use client";

/**
 * Single React hook that owns the Socket.IO connection for a multiplayer
 * room. Exposes the latest server `RoomSnapshot`, the live scoreboard,
 * connection status, and a typed actions object the UI calls into.
 *
 * Sessions:
 *   - sessionId is stored in sessionStorage under `syncle.session.<code>`.
 *   - On a refresh / network blip we reconnect with the same socket.io
 *     instance, then send `room:join` with the saved sessionId so the
 *     server reattaches us to our existing slot (preserving score, host
 *     status, etc.) instead of creating a new player.
 *
 * Lifetime:
 *   - The hook accepts `code === null` for the entry page, where we want
 *     the socket up but no room joined yet.
 *   - Calling `actions.create({ name })` or `actions.join({ code, name })`
 *     attaches us to a room.
 *   - Calling `actions.leave()` (or unmounting) tears the socket down
 *     cleanly so empty rooms hit their TTL faster.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io as createSocket, Socket } from "socket.io-client";

import type {
  AckResult,
  CatalogItem,
  ChatMessage,
  ClientToServerEvents,
  FinalStats,
  LiveScore,
  NoticeKind,
  PublicRoomEntry,
  RoomSnapshot,
  RoomVisibility,
  ScoreboardEntry,
  ServerToClientEvents,
  SongRef,
  Standing,
} from "@/lib/multi/protocol";
import type { ChartMode } from "@/lib/game/chart";

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export type ConnState = "idle" | "connecting" | "connected" | "reconnecting" | "disconnected";

export interface RoomNotice {
  id: number;
  kind: NoticeKind;
  text: string;
  at: number;
}

export interface ResultsPayload {
  standings: Standing[];
  winnerId: string;
}

/**
 * Optional config when creating a room. `name` falls back server-side to
 * "$displayName's room"; `visibility` defaults to "private". Both are
 * threaded through verbatim so a future quickplay button could create
 * with `{ visibility: "public", name: "Quickplay" }` in one call.
 */
export interface CreateRoomOptions {
  /** Room display name shown in browser + lobby header. */
  name?: string;
  /** Public rooms appear in the browser; private = code-only. */
  visibility?: RoomVisibility;
}

export interface RoomActions {
  create(
    displayName: string,
    options?: CreateRoomOptions,
  ): Promise<{ ok: true; code: string } | { ok: false; message: string }>;
  join(
    code: string,
    name: string,
  ): Promise<{ ok: true; code: string } | { ok: false; message: string }>;
  leave(): void;
  setName(name: string): void;
  /** Host: rename the room. Empty / whitespace input is ignored
   * server-side, so the previous title sticks if validation fails. */
  setRoomName(name: string): void;
  /** Host: flip room discoverability. Server validates the enum and
   * no-ops when the value already matches the current setting. */
  setRoomVisibility(visibility: RoomVisibility): void;
  /** Host: ask server to (re)fetch the catalog. */
  requestCatalog(refresh?: boolean): Promise<CatalogItem[]>;
  /**
   * Host: paginated no-query catalog browse, sorted by `sort`
   * (default: `ranked_desc`). `refresh: true` bypasses the server's
   * 5-min cache for the current page — used by the ↻ button.
   * Returns `null` on error (surfaced via lastError toast).
   */
  browseCatalog(
    page: number,
    opts?: {
      sort?: "ranked_desc" | "ranked_asc" | "plays_desc" | "rating_desc";
      refresh?: boolean;
    },
  ): Promise<{
    items: CatalogItem[];
    page: number;
    sort: string;
    hasMore: boolean;
    source: string;
  } | null>;
  /**
   * Host: text-query catalog search with explicit pagination.
   *
   * Resolves to `{ items, hasMore, page, query }`. `query` is the
   * normalized form the server actually used — caller can compare it
   * against the input they sent to detect that a stale (debounced)
   * response arrived AFTER a newer one. `hasMore` is a heuristic — UI
   * should disable Next on `false` rather than trusting it as exact.
   *
   * On error returns `null`; the error is surfaced via `lastError` for
   * the existing room-error toast, mirroring `requestCatalog`.
   */
  searchCatalog(
    query: string,
    page: number,
  ): Promise<{
    items: CatalogItem[];
    page: number;
    query: string;
    hasMore: boolean;
    source: string;
  } | null>;
  selectSong(song: SongRef): void;
  /** Host: continuously sync the picker's mode so the server has the
   * authoritative record of which tier is queued. */
  setMode(mode: ChartMode): void;
  /**
   * Host: explicit start — works whether or not everyone is ready
   * (host can choose to wait for full quorum or start anyway).
   *
   * The server does NOT flip into the loading phase immediately.
   * It stamps `RoomSnapshot.prestartEndsAt` with a 3 s countdown and
   * every client renders a centered "starting in 3, 2, 1…" overlay.
   * Cancellable via `cancelStart` during that window. See
   * `host:start` in `lib/multi/protocol.ts` for the full handshake.
   */
  startMatch(mode: ChartMode): void;
  /**
   * Host: cancel a queued (pre-start) match before the loading phase
   * begins. Server clears `prestartEndsAt`, drops the scheduled timer,
   * and emits a "Match cancelled" notice. No-op if no start is queued.
   */
  cancelStart(): void;
  cancelLoading(): void;
  /**
   * Host: pause an in-progress match. Server stamps `pausedAt` on the
   * room snapshot, every client suspends their AudioContext, and the
   * room-wide pause overlay appears. No-op outside `playing`.
   */
  pauseMatch(): void;
  /**
   * Host: resume a paused match. Server shifts `songStartedAt` by the
   * pause duration, clears `pausedAt`, and re-arms the safety timer.
   * No-op when not paused.
   */
  resumeMatch(): void;
  /**
   * Host: hard-cancel an in-progress match (countdown / playing /
   * paused) and bounce everyone to the lobby. Destructive — no
   * standings recorded. Used by the host's pause-menu cancel button.
   */
  cancelMatch(): void;
  /**
   * Non-host participant: leave the active match and sit out the rest
   * in the lobby (with a "match in progress" indicator). Idempotent
   * and a no-op for the host (server-side rejection — hosts have to
   * `cancelMatch` instead of orphaning the room). Reverses on the
   * next `transitionToLobby` automatically; there's no "rejoin
   * mid-match" affordance yet.
   */
  leaveMatch(): void;
  /**
   * Any player can fire — pulls everyone back to the lobby from the
   * results phase. The user-facing button is "Back to room" and there's
   * intentionally no host-confirmation gate.
   */
  returnToLobby(): void;
  /** Per-player lobby ready toggle. Purely informational — signals to
   * the host that the player is set; host still has to click Start. */
  setReady(ready: boolean): void;
  /** Per-client: chart parsed + audio decoded; ready to start round. */
  markReady(): void;
  reportLoadFailure(reason: string): void;
  sendScore(score: LiveScore): void;
  sendFinished(final: FinalStats): void;
  sendChoice(choice: "stay" | "leave"): void;
  /** Host: kick a player. */
  kick(sessionId: string): void;
  /** Host: mute / unmute a player's chat. */
  mute(sessionId: string, muted: boolean): void;
  /** Send a chat message; server enforces rate limit + mute. */
  sendChat(text: string): void;
  /** Browse the server's currently-listed public rooms. */
  listPublicRooms(): Promise<PublicRoomEntry[]>;
}

export interface UseRoomSocket {
  conn: ConnState;
  socketId: string | null;
  sessionId: string | null;
  snapshot: RoomSnapshot | null;
  scoreboard: ScoreboardEntry[];
  notices: RoomNotice[];
  results: ResultsPayload | null;
  /**
   * Live chat backlog. Append-on-event for sub-frame latency, then
   * reconciled with `snapshot.chat` on snapshot ticks (which is the
   * authoritative store with cap-bounded history). De-duped by id.
   */
  chat: ChatMessage[];
  /** Difficulty the host selected for the current load/play cycle. */
  selectedMode: ChartMode | null;
  /**
   * Wall-clock ms at which the server force-starts the countdown
   * (loading phase only). Clients that haven't reported `client:ready`
   * by this point are NOT kicked — they stay in the room and join
   * late once their download/decode finishes. The LoadingScreen uses
   * this to show a countdown chip + tint the progress bar.
   */
  loadDeadline: number | null;
  /** Most recent error event from the server (transient — clear on action). */
  lastError: { code: string; message: string } | null;
  /** Set when the player is kicked; UI uses this to redirect home. */
  kicked: { reason: string } | null;
  clearError(): void;
  actions: RoomActions;
}

const SESSION_PREFIX = "syncle.session.";
const NOTICE_TTL_MS = 5_000;

function readStoredSession(code: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return sessionStorage.getItem(SESSION_PREFIX + code);
  } catch {
    return null;
  }
}

function writeStoredSession(code: string, sessionId: string): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(SESSION_PREFIX + code, sessionId);
  } catch {
    /* sessionStorage unavailable / quota — non-fatal */
  }
}

function clearStoredSession(code: string): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(SESSION_PREFIX + code);
  } catch {
    /* ignore */
  }
}

/**
 * Hook signature:
 *   - `roomCode` null  → connect socket but don't auto-join a room.
 *   - `roomCode` "ABCDEF" → on connect, attempt rejoin via stored sessionId.
 *
 * We always create the socket (cheap). The actions object then performs
 * create/join via ack callbacks.
 */
export function useRoomSocket(roomCode: string | null): UseRoomSocket {
  const [conn, setConn] = useState<ConnState>("idle");
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [scoreboard, setScoreboard] = useState<ScoreboardEntry[]>([]);
  const [notices, setNotices] = useState<RoomNotice[]>([]);
  const [results, setResults] = useState<ResultsPayload | null>(null);
  const [lastError, setLastError] = useState<{ code: string; message: string } | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [socketId, setSocketId] = useState<string | null>(null);
  const [selectedMode, setSelectedMode] = useState<ChartMode | null>(null);
  const [loadDeadline, setLoadDeadline] = useState<number | null>(null);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [kicked, setKicked] = useState<{ reason: string } | null>(null);

  const socketRef = useRef<ClientSocket | null>(null);
  const codeRef = useRef<string | null>(roomCode);
  const noticeIdRef = useRef(0);
  /**
   * Outstanding `setTimeout` handles scheduled by the `room:notice`
   * handler — one per notice still inside its TTL. Tracked so we can
   * `clearTimeout` them on hook unmount: without this, a player who
   * leaves the room while a notice is still on screen leaves React
   * holding a closure over a `setNotices` setter for an unmounted
   * component, which logs a noisy "Cannot update an unmounted
   * component" warning AND keeps the closure (plus its captured
   * notice) alive in the timer queue for up to NOTICE_TTL_MS.
   */
  const noticeTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  // Track highest chat message id we've seen so the snapshot reconciliation
  // step can tell append-only deltas from a backfill of older history.
  const seenChatIdsRef = useRef<Set<number>>(new Set());

  // Keep latest code in a ref for handlers that fire after re-renders.
  useEffect(() => {
    codeRef.current = roomCode;
  }, [roomCode]);

  // Connect on mount, disconnect on unmount.
  useEffect(() => {
    setConn("connecting");
    // Default same-origin. Override via NEXT_PUBLIC_SOCKET_URL only when
    // splitting Next.js (Vercel) and the realtime server (Render).
    const opts = {
      // Prefer websocket transport but fall back to polling on hostile networks.
      transports: ["websocket", "polling"] as ("websocket" | "polling")[],
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5_000,
      reconnectionAttempts: Infinity,
    };
    const url = process.env.NEXT_PUBLIC_SOCKET_URL;
    const sock: ClientSocket = url
      ? createSocket(url, opts)
      : createSocket(opts);
    socketRef.current = sock;

    sock.on("connect", () => {
      setConn("connected");
      setSocketId(sock.id ?? null);
      // If we have a stored session for the current room, attempt rejoin.
      const code = codeRef.current;
      if (code) {
        const stored = readStoredSession(code);
        if (stored) {
          // Set sessionId IMMEDIATELY (before awaiting the rejoin ack)
          // so that any snapshot arriving from the rejoin can correctly
          // identify the local player via `players.find(p => p.id ===
          // sessionId)`. Without this, the page is stuck on "Joining
          // lobby…" because `me` is always null until the user manually
          // re-joins — but we suppress the join form precisely BECAUSE
          // we have a stored session, so the loop never resolves.
          // If the rejoin ultimately fails, the ack handler clears
          // both the storage and the state below.
          setSessionId(stored);
          sock.emit(
            "room:rejoin",
            { code, sessionId: stored },
            (res: AckResult<{ code: string }>) => {
              if (!res.ok) {
                clearStoredSession(code);
                setSessionId(null);
                setLastError({ code: res.code, message: res.message });
              }
            },
          );
        }
      }
    });
    sock.on("disconnect", () => {
      setConn("reconnecting");
    });
    sock.io.on("reconnect_attempt", () => setConn("reconnecting"));
    sock.io.on("reconnect_failed", () => setConn("disconnected"));

    sock.on("room:snapshot", (snap) => {
      setSnapshot(snap);
      // Server-driven phase changes can clear stale UI state.
      if (snap.phase === "lobby") {
        setResults(null);
        setSelectedMode(null);
        setLoadDeadline(null);
      } else if (snap.selectedMode) {
        // Sync the selected difficulty from the snapshot during
        // loading / countdown / playing phases. The one-shot
        // `phase:loading` event is the primary source, but a client
        // that joins or reconnects past that point would otherwise
        // never learn the mode and would fall back to "easy". The
        // server now mirrors `selectedMode` on every snapshot for
        // exactly this reason.
        setSelectedMode((prev) => (prev === snap.selectedMode ? prev : snap.selectedMode));
      }
      // Reconcile chat history from the snapshot: this is the source
      // of truth for late joiners + post-refresh recovery. Append-only
      // delta events still flow through `chat:message` separately for
      // sub-frame latency; here we backfill anything we don't have.
      const seen = seenChatIdsRef.current;
      const incoming = snap.chat ?? [];
      let merged: ChatMessage[] | null = null;
      for (const m of incoming) {
        if (seen.has(m.id)) continue;
        if (!merged) merged = [];
        merged.push(m);
        seen.add(m.id);
      }
      if (merged) {
        setChat((prev) => {
          const next = [...prev, ...merged!];
          // Keep ordered by id to make rendering deterministic even if
          // a snapshot delivers messages out of order.
          next.sort((a, b) => a.id - b.id);
          return next;
        });
      }
    });

    sock.on("chat:message", (msg) => {
      const seen = seenChatIdsRef.current;
      if (seen.has(msg.id)) return;
      seen.add(msg.id);
      setChat((prev) => [...prev, msg]);
    });

    sock.on("room:kicked", (payload) => {
      setKicked({ reason: payload?.reason || "You were kicked" });
    });

    sock.on("phase:loading", (payload) => {
      setSelectedMode(payload.mode);
      setLoadDeadline(payload.deadline);
    });

    sock.on("room:scoreboard", (entries) => {
      setScoreboard(entries);
    });

    sock.on("room:notice", ({ kind, text }) => {
      const id = ++noticeIdRef.current;
      const notice: RoomNotice = { id, kind, text, at: Date.now() };
      setNotices((prev) => [...prev.slice(-9), notice]);
      const timer = setTimeout(() => {
        noticeTimersRef.current.delete(timer);
        setNotices((prev) => prev.filter((n) => n.id !== id));
      }, NOTICE_TTL_MS);
      noticeTimersRef.current.add(timer);
    });

    sock.on("phase:results", (payload) => {
      setResults(payload);
    });

    sock.on("phase:lobby", () => {
      setResults(null);
    });

    sock.on("error", (payload) => {
      setLastError({ code: payload.code, message: payload.message });
    });

    return () => {
      sock.removeAllListeners();
      sock.disconnect();
      socketRef.current = null;
      // Cancel every still-pending notice TTL so we don't fire a
      // setNotices() after the component has unmounted (React 18+
      // dev mode logs a warning, and the timer otherwise pins the
      // closure + its captured notice in memory until TTL expires).
      const timers = noticeTimersRef.current;
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
  }, []);

  const callWithAck = useCallback(
    <T,>(event: keyof ClientToServerEvents, payload: unknown): Promise<AckResult<T>> => {
      return new Promise((resolve) => {
        const sock = socketRef.current;
        if (!sock) {
          resolve({ ok: false, code: "NO_SOCKET", message: "Socket not connected" });
          return;
        }
        // Socket.IO ack callback signature: (...args, cb)
        // Cast to any here because the typed Socket signature doesn't
        // generalize over arbitrary event payloads cleanly.
        (sock.emit as (ev: string, p: unknown, cb: (res: AckResult<T>) => void) => void)(
          event as string,
          payload,
          (res) => resolve(res),
        );
      });
    },
    [],
  );

  /* ---------- actions ---------- */

  const create = useCallback(
    async (displayName: string, options?: CreateRoomOptions) => {
      const res = await callWithAck<{ code: string; sessionId: string }>(
        "room:create",
        {
          displayName,
          name: options?.name,
          visibility: options?.visibility,
        },
      );
      if (!res.ok) return { ok: false as const, message: res.message };
      writeStoredSession(res.data.code, res.data.sessionId);
      setSessionId(res.data.sessionId);
      return { ok: true as const, code: res.data.code };
    },
    [callWithAck],
  );

  const join = useCallback(
    async (code: string, name: string) => {
      const stored = readStoredSession(code);
      const res = await callWithAck<{ code: string; sessionId: string }>(
        "room:join",
        { code, name, sessionId: stored ?? undefined },
      );
      if (!res.ok) return { ok: false as const, message: res.message };
      writeStoredSession(res.data.code, res.data.sessionId);
      setSessionId(res.data.sessionId);
      return { ok: true as const, code: res.data.code };
    },
    [callWithAck],
  );

  const leave = useCallback(() => {
    const sock = socketRef.current;
    if (!sock) return;
    sock.emit("room:leave");
    const code = codeRef.current;
    if (code) clearStoredSession(code);
    setSnapshot(null);
    setScoreboard([]);
    setResults(null);
    setSessionId(null);
    setChat([]);
    seenChatIdsRef.current = new Set();
  }, []);

  const setName = useCallback((name: string) => {
    socketRef.current?.emit("room:setName", { name });
  }, []);

  const setRoomName = useCallback((name: string) => {
    socketRef.current?.emit("host:setRoomName", { name });
  }, []);

  const setRoomVisibility = useCallback((visibility: RoomVisibility) => {
    socketRef.current?.emit("host:setVisibility", { visibility });
  }, []);

  const requestCatalog = useCallback(
    async (refresh = false) => {
      const res = await callWithAck<{ items: CatalogItem[] }>(
        "host:catalogRequest",
        { refresh },
      );
      if (!res.ok) {
        setLastError({ code: res.code, message: res.message });
        return [];
      }
      return res.data.items;
    },
    [callWithAck],
  );

  const browseCatalog = useCallback(
    async (
      page: number,
      opts?: {
        sort?: "ranked_desc" | "ranked_asc" | "plays_desc" | "rating_desc";
        refresh?: boolean;
      },
    ) => {
      const res = await callWithAck<{
        items: CatalogItem[];
        page: number;
        sort: string;
        hasMore: boolean;
        source: string;
      }>("host:catalogBrowse", {
        page,
        sort: opts?.sort,
        refresh: opts?.refresh,
      });
      if (!res.ok) {
        setLastError({ code: res.code, message: res.message });
        return null;
      }
      return res.data;
    },
    [callWithAck],
  );

  const searchCatalog = useCallback(
    async (query: string, page: number) => {
      const res = await callWithAck<{
        items: CatalogItem[];
        page: number;
        query: string;
        hasMore: boolean;
        source: string;
      }>("host:catalogSearch", { query, page });
      if (!res.ok) {
        setLastError({ code: res.code, message: res.message });
        return null;
      }
      return res.data;
    },
    [callWithAck],
  );

  const selectSong = useCallback((song: SongRef) => {
    socketRef.current?.emit("host:selectSong", song);
  }, []);

  const setMode = useCallback((mode: ChartMode) => {
    socketRef.current?.emit("host:setMode", { mode });
  }, []);

  const startMatch = useCallback((mode: ChartMode) => {
    socketRef.current?.emit("host:start", { mode });
  }, []);

  const cancelStart = useCallback(() => {
    socketRef.current?.emit("host:cancelStart");
  }, []);

  const cancelLoading = useCallback(() => {
    socketRef.current?.emit("host:cancelLoading");
  }, []);

  const pauseMatch = useCallback(() => {
    socketRef.current?.emit("host:pauseMatch");
  }, []);

  const resumeMatch = useCallback(() => {
    socketRef.current?.emit("host:resumeMatch");
  }, []);

  const cancelMatch = useCallback(() => {
    socketRef.current?.emit("host:cancelMatch");
  }, []);

  const leaveMatch = useCallback(() => {
    socketRef.current?.emit("room:leaveMatch");
  }, []);

  // Use the new "any player" event so clicking "Back to room" doesn't
  // require host coordination — the first click pulls everyone back.
  const returnToLobby = useCallback(() => {
    socketRef.current?.emit("room:returnToLobby");
  }, []);

  const setReady = useCallback((ready: boolean) => {
    socketRef.current?.emit("room:setReady", { ready });
  }, []);

  const markReady = useCallback(() => {
    socketRef.current?.emit("client:ready");
  }, []);

  const reportLoadFailure = useCallback((reason: string) => {
    socketRef.current?.emit("client:loadFailed", { reason });
  }, []);

  const sendScore = useCallback((score: LiveScore) => {
    socketRef.current?.emit("client:scoreUpdate", score);
  }, []);

  const sendFinished = useCallback((final: FinalStats) => {
    socketRef.current?.emit("client:finished", final);
  }, []);

  const sendChoice = useCallback((choice: "stay" | "leave") => {
    socketRef.current?.emit("client:choice", { choice });
  }, []);

  const kick = useCallback((id: string) => {
    socketRef.current?.emit("host:kick", { sessionId: id });
  }, []);

  const mute = useCallback((id: string, muted: boolean) => {
    socketRef.current?.emit("host:mute", { sessionId: id, muted });
  }, []);

  const sendChat = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    socketRef.current?.emit("chat:send", { text: trimmed });
  }, []);

  const listPublicRooms = useCallback(async () => {
    const res = await callWithAck<{ rooms: PublicRoomEntry[] }>(
      "rooms:listPublic",
      {},
    );
    if (!res.ok) {
      setLastError({ code: res.code, message: res.message });
      return [];
    }
    return res.data.rooms;
  }, [callWithAck]);

  const clearError = useCallback(() => setLastError(null), []);

  // Stabilize the actions object across renders. Each individual action
  // is already a `useCallback`, but rebuilding the wrapper object on
  // every render meant any consumer with `actions` in a hook dep array
  // would re-fire on every snapshot tick (~5Hz per peer score update,
  // plus chat / join / leave). In <MultiGame> that translated into the
  // rAF render loop being torn down + restarted multiple times per
  // second mid-song — visible as a chronic micro-stutter at match
  // start (when the snapshot churn peaks while everyone marks ready /
  // loads / countdowns) and dropped frames whenever a peer's score
  // refreshed. Memoizing here gives every consumer a stable reference
  // for the lifetime of the hook (callbacks are themselves stable, so
  // this object never changes).
  const actions = useMemo<RoomActions>(
    () => ({
      create,
      join,
      leave,
      setName,
      setRoomName,
      setRoomVisibility,
      requestCatalog,
      browseCatalog,
      searchCatalog,
      selectSong,
      setMode,
      startMatch,
      cancelStart,
      cancelLoading,
      pauseMatch,
      resumeMatch,
      cancelMatch,
      leaveMatch,
      returnToLobby,
      setReady,
      markReady,
      reportLoadFailure,
      sendScore,
      sendFinished,
      sendChoice,
      kick,
      mute,
      sendChat,
      listPublicRooms,
    }),
    [
      create,
      join,
      leave,
      setName,
      setRoomName,
      setRoomVisibility,
      requestCatalog,
      browseCatalog,
      searchCatalog,
      selectSong,
      setMode,
      startMatch,
      cancelStart,
      cancelLoading,
      pauseMatch,
      resumeMatch,
      cancelMatch,
      leaveMatch,
      returnToLobby,
      setReady,
      markReady,
      reportLoadFailure,
      sendScore,
      sendFinished,
      sendChoice,
      kick,
      mute,
      sendChat,
      listPublicRooms,
    ],
  );

  return {
    conn,
    socketId,
    sessionId,
    snapshot,
    scoreboard,
    notices,
    results,
    chat,
    selectedMode,
    loadDeadline,
    lastError,
    kicked,
    clearError,
    actions,
  };
}
