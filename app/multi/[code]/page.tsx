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

import { CopyToast } from "@/components/CopyToast";
import { GradientBg } from "@/components/GradientBg";
import { HomeButton } from "@/components/HomeButton";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ArrowIcon } from "@/components/icons/ArrowIcon";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { InGameChatWidget } from "@/components/multi/InGameChatWidget";
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
    chat,
    selectedMode,
    loadDeadline,
    lastError,
    kicked,
    clearError,
    actions,
  } = useRoomSocket(valid ? code : null);

  // Hard kick: redirect home with a one-shot toast. Sets a flag in
  // sessionStorage so the homepage can render the "you got kicked"
  // splash (handled by the homepage; if absent the user just lands
  // home and the flag self-clears).
  useEffect(() => {
    if (!kicked) return;
    try {
      sessionStorage.setItem(
        "syncle.kicked.notice",
        kicked.reason || "You were kicked",
      );
    } catch {
      /* ignore */
    }
    actions.leave();
    router.push("/multi");
  }, [kicked, actions, router]);

  // For users who hit /multi/ABCDEF cold without sessionStorage we render
  // a quick join form. Once they submit, the snapshot arrives and we drop
  // straight into the lobby.
  const [pendingName, setPendingName] = useState("");
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);

  // Tracks whether the user already has a session for THIS room cached in
  // sessionStorage — set when they came in via Create or Join from the
  // /multi entry page (which writes the sessionId before navigating).
  // While true, we never show the manual JoinForm — `useRoomSocket`
  // auto-rejoins on connect and the snapshot lands a beat later.
  // Without this guard the JoinForm would briefly flash between the
  // socket connecting and the rejoin's snapshot arriving, asking for a
  // name even though the player just typed one and clicked "Create".
  // If the auto-rejoin fails (room expired / kicked from server side)
  // the hook clears the stored session and surfaces a `lastError`; the
  // effect below re-reads storage on each error so we can gracefully
  // fall back to the JoinForm.
  const [hasStoredSession, setHasStoredSession] = useState<boolean>(() => {
    if (typeof window === "undefined" || !valid) return false;
    try {
      return !!window.sessionStorage.getItem(`syncle.session.${code}`);
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const stored = window.localStorage.getItem(NAME_STORAGE_KEY);
      if (stored) setPendingName(stored);
    } catch {
      /* ignore */
    }
  }, []);

  // Re-evaluate whether the stored session is still around whenever a
  // rejoin error fires (the hook deletes it on failure) or whenever
  // we successfully obtain a `me` (so subsequent rejoin failures —
  // e.g. server bounce — also trip the fallback correctly).
  useEffect(() => {
    if (typeof window === "undefined" || !valid) return;
    try {
      setHasStoredSession(
        !!window.sessionStorage.getItem(`syncle.session.${code}`),
      );
    } catch {
      setHasStoredSession(false);
    }
  }, [lastError, sessionId, code, valid]);

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

  // Show join form only when:
  //   - we're connected to the server,
  //   - we don't have a seat in the room yet, AND
  //   - we have NO stored session for this room (i.e. cold URL hit).
  // For Create/Join flows from /multi the sessionId is already in
  // sessionStorage, so the hook will rejoin automatically — there's no
  // sense asking for a name a second time.
  const needsJoin = conn === "connected" && !me && !hasStoredSession;

  // Gameplay phases need to break out of the page's max-width container so
  // the canvas can fill the whole viewport (minus the header), matching the
  // single-player experience. Lobby / loading / results stay in the
  // constrained card layout because they're form-style screens.
  const inGame =
    me &&
    snapshot &&
    (snapshot.phase === "countdown" || snapshot.phase === "playing");

  return (
    <main className="relative flex h-screen w-screen flex-col overflow-hidden">
      <GradientBg />

      {/* Padding kept in lockstep with the homepage / /play / /multi
          headers (px-4 sm:px-6 py-3) so the 38×38 icon-btn row
          produces the same overall header height on every page. */}
      <header className="relative z-20 flex items-center justify-between gap-3 border-b-2 border-bone-50/15 px-4 py-3 sm:px-6">
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
          className="group inline-flex items-center gap-2 font-mono text-[11.5px] uppercase tracking-widest text-bone-50/70 hover:text-accent transition-colors"
        >
          <ArrowIcon
            direction="left"
            size={14}
            strokeWidth={2.75}
            className="transition-transform duration-200 group-hover:-translate-x-0.5"
          />
          <span>Back</span>
        </button>
        {/* Center cluster: room code + connection state. The ConnectionPill
            label collapses to a dot-only badge on <sm so the row fits
            alongside the back button + theme toggle on a 320px viewport
            without the room code wrapping or being squeezed. Tracking on
            the code chip is also tightened slightly on mobile. */}
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <code className="shrink-0 border-2 border-bone-50/30 px-1.5 py-0.5 font-mono text-[10.5px] tracking-[0.25em] text-bone-50/85 sm:px-2 sm:py-1 sm:text-[11.5px] sm:tracking-[0.4em]">
            {code}
          </code>
          <ConnectionPill conn={conn} />
        </div>
        <div className="flex items-center gap-2 sm:gap-3">
          {/* Leave the room cleanly before navigating home, otherwise
              the socket lingers and the player still appears in the
              roster to other clients for the connection-grace window. */}
          <HomeButton onNavigate={() => actions.leave()} />
          <ThemeToggle />
        </div>
      </header>

      <NoticeStack notices={notices} />

      {inGame ? (
        // Full-bleed game area: canvas fills the rest of the viewport
        // (header + this flex-1 region = 100vh). MultiGame draws its own
        // overlays (score/combo top-left, scoreboard right) on top.
        // The InGameChatWidget sits above as a sibling so it can float
        // in the bottom-right without participating in the canvas
        // layout.
        <div className="relative z-10 min-h-0 flex-1">
          {me && snapshot && (
            <RoomBody
              code={code}
              snapshot={snapshot}
              scoreboard={scoreboard}
              results={results}
              chat={chat}
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
          {me && (
            <InGameChatWidget
              chat={chat}
              meId={me.id}
              meIsMuted={!!me.muted}
              actions={actions}
            />
          )}
        </div>
      ) : (
        <div className="relative z-10 mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 overflow-y-auto px-4 pt-6 pb-12 sm:px-6">
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

          {/* Connecting card covers two cases:
                1. socket isn't connected yet (initial handshake / reconnecting),
                2. socket IS connected and we have a stored session for this
                   room, so the hook is mid-rejoin — show "joining" UI rather
                   than the JoinForm or a blank page. */}
          {!needsJoin && !me && <ConnectingCard conn={conn} />}

          {me && snapshot && (
            <RoomBody
              code={code}
              snapshot={snapshot}
              scoreboard={scoreboard}
              results={results}
              chat={chat}
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
            // Width-locked to the JoinForm / ConnectingCard above so
            // the error banner reads as a sibling of that card instead
            // of a full-bleed strip across the page. Both surfaces use
            // `mx-auto w-full max-w-md` — keep them in lockstep here.
            <div className="brut-card-accent mx-auto flex w-full max-w-md items-start justify-between gap-3 p-3">
              <p className="font-mono text-[0.79rem]">
                <span className="text-rose-400">[{lastError.code}]</span>{" "}
                {lastError.message}
              </p>
              <button onClick={clearError} className="font-mono text-[10.5px] uppercase tracking-widest text-bone-50/70 hover:text-accent">
                dismiss
              </button>
            </div>
          )}
        </div>
      )}
    </main>
  );
}

/* ---------------------------------------------------------------------- */
/* Body                                                                   */
/* ---------------------------------------------------------------------- */

import type { ChatMessage, RoomSnapshot, ScoreboardEntry } from "@/lib/multi/protocol";
import type { ResultsPayload, RoomActions } from "@/hooks/useRoomSocket";

function RoomBody({
  code,
  snapshot,
  scoreboard,
  results,
  chat,
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
  chat: ChatMessage[];
  me: string;
  isHost: boolean;
  actions: RoomActions;
  loadedChart: LoadSongResult | null;
  loadProgress: string | null;
  loadError: string | null;
  loadDeadline: number | null;
  selectedMode: ChartMode | null;
}) {
  // Wrap each phase in a fade-in shell so transitions from one phase
  // to another don't pop. The shell uses Tailwind's `animate-fade-in`
  // (defined in globals.css) which is a 220ms opacity ramp — enough
  // to feel intentional without slowing anyone down. The `key`
  // attribute on the wrapper is the phase name so React fully unmounts
  // / re-mounts on phase change, re-firing the animation.
  const inner = (() => {
    switch (snapshot.phase) {
      case "lobby":
        return (
          <Lobby
            code={code}
            snapshot={snapshot}
            meId={me}
            isHost={isHost}
            chat={chat}
            actions={actions}
          />
        );
      case "loading":
        return (
          <LoadingScreen
            snapshot={snapshot}
            chat={chat}
            meId={me}
            progress={loadProgress}
            error={loadError}
            isHost={isHost}
            mode={selectedMode}
            deadline={loadDeadline}
            onCancel={actions.cancelLoading}
            actions={actions}
          />
        );
      case "countdown":
      case "playing":
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
            chat={chat}
            me={me}
            isHost={isHost}
            actions={actions}
          />
        );
      default:
        return null;
    }
  })();
  return (
    <div key={snapshot.phase} className="phase-shell">
      {inner}
    </div>
  );
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
    <span
      className="inline-flex min-w-0 items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-widest text-bone-50/60"
      data-tooltip={text}
    >
      <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`} />
      {/* Hide the verbose label on phones so the room code + back button
          + theme toggle don't fight for space; the colored dot still
          communicates the state, and the data-tooltip exposes the
          full text on hover for assistive / desktop contexts. */}
      <span className="hidden truncate sm:inline">{text}</span>
    </span>
  );
}

function ConnectingCard({ conn }: { conn: string }) {
  // Three states map to three different copy lines so the user always
  // knows what the spinner is waiting on. "connected" lands here only
  // when we have a stored session for this room and the hook is
  // mid-rejoin — the socket handshake itself is already done.
  const label =
    conn === "connected"
      ? "Joining lobby…"
      : conn === "reconnecting"
        ? "Reconnecting to the room…"
        : "Opening socket…";
  return (
    <div className="brut-card mx-auto w-full max-w-md p-5 sm:p-6">
      <p className="font-mono text-[10.5px] uppercase tracking-[0.4em] text-accent">
        ░ {conn === "connected" ? "Joining" : "Connecting"}
      </p>
      <div className="mt-3 flex items-center gap-3">
        <span className="inline-block h-[1.05rem] w-[1.05rem] shrink-0 animate-spin rounded-full border-2 border-bone-50/20 border-t-accent" />
        <p className="font-mono text-[0.79rem] uppercase tracking-widest text-bone-50/80">
          {label}
        </p>
      </div>
      {conn !== "connected" && (
        <p className="mt-3 text-[11.5px] leading-snug text-bone-50/55">
          Free Render servers sleep when idle and take ~30 s to wake on the
          first connection. Once you&rsquo;re in the room, everything else is
          instant.
        </p>
      )}
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
  const { copy, copied } = useCopyToClipboard();
  return (
    <div className="brut-card mx-auto w-full max-w-md p-5 sm:p-6">
      <p className="font-mono text-[10.5px] uppercase tracking-[0.4em] text-accent">
        Joining room
      </p>
      {/* Code doubles as a copy-to-clipboard button so the joiner
          can share the same code with another friend in one click.
          Mirrors the host's "code + ⧉" button in the lobby. Inline-
          flex with `w-fit` so the click target is just the code +
          icon, not the full row. CopyToast pops above on success. */}
      <div className="relative mt-1 w-fit">
        <CopyToast visible={copied} />
        <button
          type="button"
          onClick={() => copy(code)}
          data-tooltip="Copy room code"
          className="group inline-flex items-center gap-2 font-display text-[1.58rem] font-bold leading-none text-bone-50 transition-colors hover:text-accent"
        >
          <span>{code}</span>
          <span
            aria-hidden
            className="text-[1.05rem] leading-none text-bone-50/50 transition-colors group-hover:text-accent"
          >
            ⧉
          </span>
        </button>
      </div>
      <label className="mt-4 block">
        <span className="font-mono text-[10.5px] uppercase tracking-widest text-bone-50/60">
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
          className="mt-1 block w-full border-2 border-bone-50/20 bg-transparent px-3 py-2 font-mono text-[0.92rem] text-bone-50 outline-none focus:border-accent transition-colors"
        />
      </label>
      <button
        onClick={onSubmit}
        disabled={busy || !name.trim()}
        className="brut-btn-accent group mt-4 inline-flex w-full items-center justify-center gap-2 px-4 py-3 disabled:opacity-50"
      >
        {busy ? (
          <span>Joining…</span>
        ) : (
          <>
            <span>Join room</span>
            <ArrowIcon
              direction="right"
              size={15}
              strokeWidth={2.75}
              className="transition-transform duration-200 group-hover:translate-x-0.5"
            />
          </>
        )}
      </button>
      {error && (
        <p className="mt-3 border-2 border-rose-500 p-2 font-mono text-[0.79rem] text-rose-400">
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
          className="brut-card-accent pointer-events-auto px-3 py-2 font-mono text-[11.5px] text-bone-50/90 shadow-lg"
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
        <p className="font-mono text-[10.5px] uppercase tracking-[0.4em] text-rose-400">
          Bad room code
        </p>
        <h1 className="font-display text-[1.97rem] font-bold">{code || "—"}</h1>
        <p className="text-[0.92rem] text-bone-50/70">
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
