"use client";

/**
 * The live multiplayer room. Owns the socket for the duration of the page
 * and routes between phase-specific UI:
 *
 *   lobby     → <Lobby> (player list, host song picker, start button)
 *   loading   → <LoadingScreen> (download + decode the host's pick, send "ready")
 *   countdown → <MultiGame> (already showing the highway with countdown overlay)
 *   playing   → <MultiGame> (canvas + sidebar scoreboard)
 *   results   → <ResultsScreen> (final standings, keep playing / leave)
 *
 * If the URL is hit cold (no sessionStorage entry for this code) we present
 * a "join with name" form instead of the lobby — same flow as `/multi`,
 * but pre-filled with the code from the URL.
 */

import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { GradientBg } from "@/components/GradientBg";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ArrowIcon } from "@/components/icons/ArrowIcon";
import { Lobby } from "@/components/multi/Lobby";
import { LoadingScreen } from "@/components/multi/LoadingScreen";
import { MultiGame } from "@/components/multi/MultiGame";
import { ResultsScreen } from "@/components/multi/ResultsScreen";
import { useRoomSocket } from "@/hooks/useRoomSocket";
import { isValidRoomCode } from "@/lib/multi/protocol";
import type { LoadSongResult, ChartMode } from "@/lib/game/chart";
import { loadSongById } from "@/lib/game/chart";

const NAME_STORAGE_KEY = "syncle.multi.name";

export default function MultiRoomPage() {
  const params = useParams();
  const router = useRouter();
  const rawCode = (Array.isArray(params?.code) ? params.code[0] : params?.code) ?? "";
  const code = String(rawCode).toUpperCase();
  const valid = isValidRoomCode(code);

  const {
    conn,
    sessionId,
    snapshot,
    scoreboard,
    notices,
    results,
    selectedMode,
    loadDeadline,
    lastError,
    clearError,
    actions,
  } = useRoomSocket(valid ? code : null);

  // For users who hit /multi/ABCDEF cold without sessionStorage we render
  // a quick join form. Once they submit, the snapshot arrives and we drop
  // straight into the lobby.
  const [pendingName, setPendingName] = useState("");
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const stored = window.localStorage.getItem(NAME_STORAGE_KEY);
      if (stored) setPendingName(stored);
    } catch {
      /* ignore */
    }
  }, []);

  // We "have a seat" once the server has sent us a snapshot containing our
  // sessionId. Otherwise we either (a) are mid-rejoin and waiting, or
  // (b) need to actively join via the join form.
  const me = useMemo(() => {
    if (!snapshot || !sessionId) return null;
    return snapshot.players.find((p) => p.id === sessionId) ?? null;
  }, [snapshot, sessionId]);

  // ---- chart loading (triggered by phase:loading) -----------------------
  const [loadedChart, setLoadedChart] = useState<LoadSongResult | null>(null);
  const [loadProgress, setLoadProgress] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const lastLoadedKeyRef = useRef<string | null>(null);

  // When the snapshot says "loading" with a selected song, kick off the
  // download. We dedup by `${beatmapsetId}:${mode}` so we don't re-download
  // when the snapshot ticks for unrelated reasons (player joined, name
  // changed, etc).
  useEffect(() => {
    if (!snapshot) return;
    if (snapshot.phase !== "loading") return;
    const song = snapshot.selectedSong;
    if (!song) return;
    // The host's chosen difficulty is communicated via the `phase:loading`
    // event (kept off the snapshot to avoid renegotiating mid-play). If we
    // somehow missed the event (joined right at phase change), fall back to
    // "easy" — the server will still gate hits + the load works regardless.
    const targetMode: ChartMode = selectedMode ?? "easy";

    const key = `${song.beatmapsetId}:${targetMode}`;
    if (lastLoadedKeyRef.current === key) return;
    lastLoadedKeyRef.current = key;

    setLoadedChart(null);
    setLoadProgress(`Downloading ${song.artist} — ${song.title}…`);
    setLoadError(null);

    let cancelled = false;
    loadSongById(song.beatmapsetId, targetMode, {
      onProgress: (msg) => {
        if (!cancelled) setLoadProgress(msg);
      },
    })
      .then((res) => {
        if (cancelled) return;
        setLoadedChart(res);
        setLoadProgress(null);
        actions.markReady();
      })
      .catch((err) => {
        if (cancelled) return;
        const msg = err?.message ?? "Failed to load song";
        setLoadError(msg);
        actions.reportLoadFailure(msg);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot?.phase, snapshot?.selectedSong?.beatmapsetId, selectedMode]);

  // Reset the chart when we go back to lobby so a fresh round can re-trigger
  // the loading effect for the same song (same key) without thinking it was
  // already done.
  useEffect(() => {
    if (snapshot?.phase === "lobby") {
      lastLoadedKeyRef.current = null;
      setLoadedChart(null);
      setLoadProgress(null);
      setLoadError(null);
    }
  }, [snapshot?.phase]);

  /* ------------- join form (for cold URL hits) ------------- */
  const handleJoin = useCallback(async () => {
    const name = pendingName.trim();
    if (!name) return;
    setJoining(true);
    setJoinError(null);
    const res = await actions.join(code, name);
    if (!res.ok) {
      setJoinError(res.message);
      setJoining(false);
      return;
    }
    try {
      window.localStorage.setItem(NAME_STORAGE_KEY, name);
    } catch {
      /* ignore */
    }
    setJoining(false);
  }, [pendingName, actions, code]);

  if (!valid) {
    return <InvalidCodeScreen code={String(rawCode)} onBack={() => router.push("/multi")} />;
  }

  // Show join form if we don't have a seat yet AND we're connected.
  // (While conn is "connecting" we just show a spinner.)
  const needsJoin = conn === "connected" && !me;

  return (
    <main className="relative min-h-screen overflow-hidden">
      <GradientBg />

      <header className="relative z-20 flex items-center justify-between gap-3 border-b-2 border-bone-50/15 px-4 py-3 sm:px-8 sm:py-4">
        <button
          onClick={() => {
            actions.leave();
            // Prefer browser history so we land on whatever page sent us
            // here (lobby, the /multi entry, the homepage, a friend's
            // shared link page, etc). If there's no history (direct hit
            // on the URL), fall back to the multiplayer entry.
            if (typeof window !== "undefined" && window.history.length > 1) {
              router.back();
            } else {
              router.push("/multi");
            }
          }}
          className="group inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest text-bone-50/70 hover:text-accent transition-colors"
        >
          <ArrowIcon
            direction="left"
            size={13}
            strokeWidth={2.75}
            className="transition-transform duration-200 group-hover:-translate-x-0.5"
          />
          <span>Back</span>
        </button>
        <div className="flex items-center gap-3">
          <code className="border-2 border-bone-50/30 px-2 py-1 font-mono text-[11px] tracking-[0.4em] text-bone-50/85">
            {code}
          </code>
          <ConnectionPill conn={conn} />
        </div>
        <ThemeToggle />
      </header>

      <NoticeStack notices={notices} />

      <div className="relative z-10 mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 pt-6 pb-12 sm:px-6">
        {needsJoin && (
          <JoinForm
            code={code}
            name={pendingName}
            onName={setPendingName}
            onSubmit={handleJoin}
            busy={joining}
            error={joinError}
          />
        )}

        {conn !== "connected" && !needsJoin && <ConnectingCard conn={conn} />}

        {me && snapshot && (
          <RoomBody
            code={code}
            snapshot={snapshot}
            scoreboard={scoreboard}
            results={results}
            me={me.id}
            isHost={me.isHost}
            actions={actions}
            loadedChart={loadedChart}
            loadProgress={loadProgress}
            loadError={loadError}
            loadDeadline={loadDeadline}
            selectedMode={selectedMode}
          />
        )}

        {lastError && (
          <div className="brut-card-accent flex items-start justify-between gap-3 p-3">
            <p className="font-mono text-xs">
              <span className="text-rose-400">[{lastError.code}]</span>{" "}
              {lastError.message}
            </p>
            <button onClick={clearError} className="font-mono text-[10px] uppercase tracking-widest text-bone-50/70 hover:text-accent">
              dismiss
            </button>
          </div>
        )}
      </div>
    </main>
  );
}

/* ---------------------------------------------------------------------- */
/* Body                                                                   */
/* ---------------------------------------------------------------------- */

import type { RoomSnapshot, ScoreboardEntry } from "@/lib/multi/protocol";
import type { ResultsPayload, RoomActions } from "@/hooks/useRoomSocket";

function RoomBody({
  code,
  snapshot,
  scoreboard,
  results,
  me,
  isHost,
  actions,
  loadedChart,
  loadProgress,
  loadError,
  loadDeadline,
  selectedMode,
}: {
  code: string;
  snapshot: RoomSnapshot;
  scoreboard: ScoreboardEntry[];
  results: ResultsPayload | null;
  me: string;
  isHost: boolean;
  actions: RoomActions;
  loadedChart: LoadSongResult | null;
  loadProgress: string | null;
  loadError: string | null;
  loadDeadline: number | null;
  selectedMode: ChartMode | null;
}) {
  switch (snapshot.phase) {
    case "lobby":
      return (
        <Lobby
          code={code}
          snapshot={snapshot}
          isHost={isHost}
          actions={actions}
        />
      );
    case "loading":
      return (
        <LoadingScreen
          snapshot={snapshot}
          progress={loadProgress}
          error={loadError}
          isHost={isHost}
          mode={selectedMode}
          deadline={loadDeadline}
          onCancel={actions.cancelLoading}
        />
      );
    case "countdown":
    case "playing":
      // We render MultiGame even if loadedChart is missing (e.g. for late
      // joiners); the component shows a spinner until the chart arrives.
      return (
        <MultiGame
          snapshot={snapshot}
          scoreboard={scoreboard}
          loaded={loadedChart}
          loadError={loadError}
          actions={actions}
          me={me}
          mode={selectedMode ?? "easy"}
        />
      );
    case "results":
      return (
        <ResultsScreen
          snapshot={snapshot}
          results={results}
          me={me}
          isHost={isHost}
          actions={actions}
        />
      );
    default:
      return null;
  }
}

/* ---------------------------------------------------------------------- */
/* Sub-components                                                         */
/* ---------------------------------------------------------------------- */

function ConnectionPill({ conn }: { conn: string }) {
  const dotClass =
    conn === "connected"
      ? "bg-accent"
      : conn === "disconnected"
        ? "bg-rose-400"
        : "bg-yellow-400 animate-pulse";
  const text =
    conn === "connecting"
      ? "Connecting…"
      : conn === "connected"
        ? "Live"
        : conn === "reconnecting"
          ? "Reconnecting…"
          : "Disconnected";
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-bone-50/60">
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${dotClass}`} />
      {text}
    </span>
  );
}

function ConnectingCard({ conn }: { conn: string }) {
  return (
    <div className="brut-card mx-auto w-full max-w-md p-5 sm:p-6">
      <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-accent">
        ░ Connecting
      </p>
      <div className="mt-3 flex items-center gap-3">
        <span className="inline-block h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-bone-50/20 border-t-accent" />
        <p className="font-mono text-xs uppercase tracking-widest text-bone-50/80">
          {conn === "reconnecting"
            ? "Reconnecting to the room…"
            : "Opening socket…"}
        </p>
      </div>
      <p className="mt-3 text-[11px] leading-snug text-bone-50/55">
        Free Render servers sleep when idle and take ~30 s to wake on the
        first connection. Once you&rsquo;re in the room, everything else is
        instant.
      </p>
    </div>
  );
}

function JoinForm({
  code,
  name,
  onName,
  onSubmit,
  busy,
  error,
}: {
  code: string;
  name: string;
  onName: (n: string) => void;
  onSubmit: () => void;
  busy: boolean;
  error: string | null;
}) {
  return (
    <div className="brut-card mx-auto w-full max-w-md p-5 sm:p-6">
      <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-accent">
        Joining room
      </p>
      <h2 className="mt-1 font-display text-2xl font-bold">{code}</h2>
      <label className="mt-4 block">
        <span className="font-mono text-[10px] uppercase tracking-widest text-bone-50/60">
          Your name
        </span>
        <input
          autoFocus
          type="text"
          value={name}
          onChange={(e) => onName(e.target.value.slice(0, 20))}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSubmit();
          }}
          placeholder="player"
          maxLength={20}
          className="mt-1 block w-full border-2 border-bone-50/20 bg-transparent px-3 py-2 font-mono text-sm text-bone-50 outline-none focus:border-accent transition-colors"
        />
      </label>
      <button
        onClick={onSubmit}
        disabled={busy || !name.trim()}
        className="brut-btn-accent mt-4 w-full px-4 py-3 disabled:opacity-50"
      >
        {busy ? "Joining…" : "→ Join room"}
      </button>
      {error && (
        <p className="mt-3 border-2 border-rose-500 p-2 font-mono text-xs text-rose-400">
          {error}
        </p>
      )}
    </div>
  );
}

function NoticeStack({
  notices,
}: {
  notices: { id: number; kind: string; text: string }[];
}) {
  if (notices.length === 0) return null;
  return (
    <div className="pointer-events-none fixed right-4 top-20 z-30 flex max-w-xs flex-col items-end gap-2">
      {notices.slice(-5).map((n) => (
        <div
          key={n.id}
          className="brut-card-accent pointer-events-auto px-3 py-2 font-mono text-[11px] text-bone-50/90 shadow-lg"
        >
          {n.text}
        </div>
      ))}
    </div>
  );
}

function InvalidCodeScreen({ code, onBack }: { code: string; onBack: () => void }) {
  return (
    <main className="relative min-h-screen">
      <GradientBg />
      <div className="relative z-10 mx-auto flex max-w-md flex-col items-center justify-center gap-4 px-4 py-32 text-center">
        <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-rose-400">
          Bad room code
        </p>
        <h1 className="font-display text-3xl font-bold">{code || "—"}</h1>
        <p className="text-sm text-bone-50/70">
          Room codes are 6 characters, A–Z and 2–9. Double-check what your
          friend sent and try again.
        </p>
        <button onClick={onBack} className="brut-btn-accent px-6 py-3">
          Back to multiplayer
        </button>
      </div>
    </main>
  );
}
