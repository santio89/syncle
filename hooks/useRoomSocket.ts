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

import { useCallback, useEffect, useRef, useState } from "react";
import { io as createSocket, Socket } from "socket.io-client";

import type {
  AckResult,
  CatalogItem,
  ClientToServerEvents,
  FinalStats,
  LiveScore,
  NoticeKind,
  RoomSnapshot,
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

export interface RoomActions {
  create(name: string): Promise<
    { ok: true; code: string } | { ok: false; message: string }
  >;
  join(
    code: string,
    name: string,
  ): Promise<{ ok: true; code: string } | { ok: false; message: string }>;
  leave(): void;
  setName(name: string): void;
  /** Host: ask server to (re)fetch the catalog. */
  requestCatalog(refresh?: boolean): Promise<CatalogItem[]>;
  selectSong(song: SongRef): void;
  startMatch(mode: ChartMode): void;
  cancelLoading(): void;
  returnToLobby(): void;
  markReady(): void;
  reportLoadFailure(reason: string): void;
  sendScore(score: LiveScore): void;
  sendFinished(final: FinalStats): void;
  sendChoice(choice: "stay" | "leave"): void;
}

export interface UseRoomSocket {
  conn: ConnState;
  socketId: string | null;
  sessionId: string | null;
  snapshot: RoomSnapshot | null;
  scoreboard: ScoreboardEntry[];
  notices: RoomNotice[];
  results: ResultsPayload | null;
  /** Difficulty the host selected for the current load/play cycle. */
  selectedMode: ChartMode | null;
  /** Wall-clock ms by which clients must be ready (loading phase only). */
  loadDeadline: number | null;
  /** Most recent error event from the server (transient — clear on action). */
  lastError: { code: string; message: string } | null;
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

  const socketRef = useRef<ClientSocket | null>(null);
  const codeRef = useRef<string | null>(roomCode);
  const noticeIdRef = useRef(0);

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
          sock.emit(
            "room:rejoin",
            { code, sessionId: stored },
            (res: AckResult<{ code: string }>) => {
              if (!res.ok) {
                clearStoredSession(code);
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
      }
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
      setTimeout(() => {
        setNotices((prev) => prev.filter((n) => n.id !== id));
      }, NOTICE_TTL_MS);
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
    async (name: string) => {
      const res = await callWithAck<{ code: string; sessionId: string }>(
        "room:create",
        { name },
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
  }, []);

  const setName = useCallback((name: string) => {
    socketRef.current?.emit("room:setName", { name });
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

  const selectSong = useCallback((song: SongRef) => {
    socketRef.current?.emit("host:selectSong", song);
  }, []);

  const startMatch = useCallback((mode: ChartMode) => {
    socketRef.current?.emit("host:start", { mode });
  }, []);

  const cancelLoading = useCallback(() => {
    socketRef.current?.emit("host:cancelLoading");
  }, []);

  const returnToLobby = useCallback(() => {
    socketRef.current?.emit("host:returnToLobby");
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

  const clearError = useCallback(() => setLastError(null), []);

  return {
    conn,
    socketId,
    sessionId,
    snapshot,
    scoreboard,
    notices,
    results,
    selectedMode,
    loadDeadline,
    lastError,
    clearError,
    actions: {
      create,
      join,
      leave,
      setName,
      requestCatalog,
      selectSong,
      startMatch,
      cancelLoading,
      returnToLobby,
      markReady,
      reportLoadFailure,
      sendScore,
      sendFinished,
      sendChoice,
    },
  };
}
