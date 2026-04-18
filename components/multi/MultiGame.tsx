"use client";

/**
 * Multiplayer game view: shared canvas highway + live sidebar scoreboard.
 *
 * Audio sync strategy:
 *   - The server picks a wall-clock `startsAt` after every client says
 *     `client:ready` (countdown phase). All clients aim to start their
 *     `AudioEngine` at exactly that moment via `setTimeout(..., delta)`.
 *   - During countdown we render a translucent overlay counting down from
 *     ceil((startsAt - now)/1000). Audio is scheduled inside `start()`
 *     using the engine's existing `delay` arg, so even small browser
 *     timer skews are absorbed into the same fixed lead-in.
 *   - Once `phase` flips to `playing`, the overlay drops and gameplay is
 *     identical to single-player from a feel standpoint. We never re-sync
 *     mid-song — too disruptive — but the wall-clock starting point keeps
 *     everyone within ~50ms of each other for the whole run.
 *
 * Score reporting:
 *   - 5Hz throttled `client:scoreUpdate` while playing.
 *   - One `client:finished` at end-of-song.
 *
 * The component intentionally re-uses single-player primitives (GameState,
 * AudioEngine, drawFrame) so any future renderer/engine improvements
 * automatically flow into the multiplayer view.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { ArrowIcon } from "@/components/icons/ArrowIcon";
import { useTheme } from "@/components/ThemeProvider";
import type { RoomActions } from "@/hooks/useRoomSocket";
import { AudioEngine } from "@/lib/game/audio";
import { GameState, isHold } from "@/lib/game/engine";
import type { LoadSongResult, ChartMode } from "@/lib/game/chart";
import {
  createRenderState,
  crossedComboMilestone,
  DEFAULT_RENDER_OPTIONS,
  drawFrame,
  RenderState,
} from "@/lib/game/renderer";
import {
  PlayerStats,
  TOTAL_LANES,
} from "@/lib/game/types";
import type { LiveScore, RoomSnapshot, ScoreboardEntry } from "@/lib/multi/protocol";

const KEY_TO_LANE: Record<string, number> = {
  KeyD: 0, ArrowLeft: 0,
  KeyF: 1, ArrowDown: 1,
  KeyJ: 2, ArrowUp: 2,
  KeyK: 3, ArrowRight: 3,
};

const SCORE_TICK_MS = 200; // 5 Hz

export function MultiGame({
  snapshot,
  scoreboard,
  loaded,
  loadError,
  actions,
  me,
  mode,
}: {
  snapshot: RoomSnapshot;
  scoreboard: ScoreboardEntry[];
  loaded: LoadSongResult | null;
  loadError: string | null;
  actions: RoomActions;
  me: string;
  mode: ChartMode;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <CanvasPane
        snapshot={snapshot}
        loaded={loaded}
        loadError={loadError}
        actions={actions}
        mode={mode}
      />
      <ScoreboardSidebar scoreboard={scoreboard} me={me} snapshot={snapshot} />
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Canvas pane                                                              */
/* ------------------------------------------------------------------------ */

function CanvasPane({
  snapshot,
  loaded,
  loadError,
  actions,
  mode,
}: {
  snapshot: RoomSnapshot;
  loaded: LoadSongResult | null;
  loadError: string | null;
  actions: RoomActions;
  mode: ChartMode;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioRef = useRef<AudioEngine | null>(null);
  const stateRef = useRef<GameState | null>(null);
  const renderStateRef = useRef<RenderState>(createRenderState());
  const heldRef = useRef<boolean[]>(new Array(TOTAL_LANES).fill(false));
  const rafRef = useRef<number | null>(null);
  const renderOptsRef = useRef({ ...DEFAULT_RENDER_OPTIONS });
  const emptyStateRef = useRef<GameState>(new GameState([]));
  const lastScheduledBeatRef = useRef<number>(-1);
  const lastScoreSentRef = useRef<number>(0);
  /**
   * Last score we actually sent to the server. Lets us skip the wire
   * payload entirely on ticks where nothing changed (player isn't hitting
   * notes), keeping the 50-player room's ingress tiny on idle stretches.
   * We compare a small (score, combo, miss) tuple — those are the only
   * fields the sidebar visibly cares about between ticks.
   */
  const lastScoreSentSigRef = useRef<string>("");
  const finishedRef = useRef<boolean>(false);
  /** Combo on the previous frame — see Game.tsx for the rationale. */
  const prevComboRef = useRef<number>(0);

  const [stats, setStats] = useState<PlayerStats | null>(null);
  const [countdownLabel, setCountdownLabel] = useState<number | null>(null);

  const { theme } = useTheme();
  useEffect(() => {
    renderOptsRef.current.theme = theme;
    renderStateRef.current.cache = undefined;
  }, [theme]);

  // Crisp canvas + DPR resize
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.floor(rect.width * dpr);
      canvas.height = Math.floor(rect.height * dpr);
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      renderStateRef.current.cache = undefined;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    window.addEventListener("orientationchange", resize);
    return () => {
      ro.disconnect();
      window.removeEventListener("orientationchange", resize);
    };
  }, []);

  /* -------- audio prep + scheduled start at server's startsAt -------- */
  // Whenever the chart finishes loading, decode it into a fresh AudioEngine.
  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    const prep = async () => {
      try {
        if (!audioRef.current) audioRef.current = new AudioEngine();
        audioRef.current.ensureContext();
        if (loaded.delivery === "remote" && loaded.audioBytes && loaded.audioKey) {
          await audioRef.current.loadFromBytes(
            loaded.audioBytes.slice(0),
            loaded.audioKey,
          );
        } else if (loaded.meta.audioUrl) {
          await audioRef.current.load(loaded.meta.audioUrl);
        }
      } catch {
        // Silent — countdown effect will retry start anyway.
      }
      if (cancelled) return;
      stateRef.current = new GameState(loaded.notes);
      setStats({ ...stateRef.current.stats });
      lastScheduledBeatRef.current = -1;
      finishedRef.current = false;
      prevComboRef.current = 0;
      lastScoreSentSigRef.current = "";
      // Wipe leftover particles/shockwaves/milestone from a previous song
      // so the new run starts on a clean canvas.
      const rs = renderStateRef.current;
      rs.particles.length = 0;
      rs.shockwaves.length = 0;
      rs.pendingHits.length = 0;
      rs.laneFlash.fill(0);
      rs.laneAnticipation.fill(0);
      rs.combo = 0;
      rs.milestone = null;
    };
    void prep();
    return () => {
      cancelled = true;
    };
  }, [loaded]);

  // Schedule the audio start exactly at snapshot.startsAt (countdown→playing).
  //
  // Late-join behavior: if the song has already begun (we mounted into a
  // room that's mid-song after a refresh, or our chart loaded after the
  // server-side countdown finished), startsAt is in the past. Instead of
  // hammering start() with a 0-delay (which would replay from the top and
  // desync the player from the rest of the lobby), we seek into the audio
  // buffer by `now - startsAt` seconds. The engine's songTime() then reads
  // chart-relative time correctly, so the player drops in mid-song already
  // synced to everyone else's playhead within ~1 frame.
  useEffect(() => {
    if (!loaded || !audioRef.current) return;
    if (snapshot.phase !== "countdown" && snapshot.phase !== "playing") return;
    const startsAt = snapshot.startsAt ?? snapshot.songStartedAt;
    if (!startsAt) return;
    const delayMs = startsAt - Date.now();
    const audio = audioRef.current;
    let cancelled = false;
    const schedule = () => {
      if (cancelled) return;
      try {
        if (delayMs >= 0) {
          // Future start — normal countdown lead-in.
          audio.start(delayMs / 1000, 0.85);
        } else {
          // Past start — seek to the right offset so we sound in time.
          // We give ourselves a tiny 50ms head-start so the fade-in doesn't
          // cut into the very first frame after mount.
          const offset = -delayMs / 1000;
          audio.start(0.05, 0.85, offset);
        }
      } catch {
        // The engine throws if the buffer isn't loaded yet. We retry on the
        // next render once the prep effect resolves.
      }
    };
    schedule();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, snapshot.startsAt, snapshot.songStartedAt]);

  // Countdown overlay tick
  useEffect(() => {
    if (snapshot.phase !== "countdown" || !snapshot.startsAt) {
      setCountdownLabel(null);
      return;
    }
    const tick = () => {
      const remaining = (snapshot.startsAt! - Date.now()) / 1000;
      if (remaining <= 0) {
        setCountdownLabel(null);
        return;
      }
      setCountdownLabel(Math.ceil(remaining));
      raf = requestAnimationFrame(tick);
    };
    let raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [snapshot.phase, snapshot.startsAt]);

  /* -------- input -------- */
  useEffect(() => {
    if (snapshot.phase !== "playing" && snapshot.phase !== "countdown") return;
    const onKeyDown = (e: KeyboardEvent) => {
      // Skip when the user is typing in a form field (future chat, name
      // change, etc). Same guard as single-player Game.tsx.
      if (isEditableTarget(e.target)) return;
      const lane = KEY_TO_LANE[e.code];
      if (lane === undefined) return;
      if (e.repeat) return;
      e.preventDefault();
      heldRef.current[lane] = true;
      if (snapshot.phase !== "playing") return;
      const audio = audioRef.current;
      const state = stateRef.current;
      if (!audio || !state) return;
      const songTime = audio.songTime();
      const evt = state.hit(lane, songTime);
      if (evt) {
        renderStateRef.current.laneFlash[lane] = 1;
        renderStateRef.current.pendingHits.push({ lane, judgment: evt.judgment });
        audio.playHit(lane, evt.judgment);
      } else {
        renderStateRef.current.laneFlash[lane] = 0.45;
        audio.playMiss(true);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      const lane = KEY_TO_LANE[e.code];
      if (lane === undefined) return;
      heldRef.current[lane] = false;
      if (snapshot.phase !== "playing") return;
      const audio = audioRef.current;
      const state = stateRef.current;
      if (!audio || !state) return;
      const tailEvt = state.release(lane, audio.songTime());
      if (tailEvt) {
        renderStateRef.current.laneFlash[lane] = 0.6;
        renderStateRef.current.pendingHits.push({
          lane,
          judgment: tailEvt.judgment,
          tail: true,
        });
        audio.playRelease(lane, tailEvt.judgment);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [snapshot.phase]);

  /* -------- render loop -------- */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let last = performance.now();
    let lastHud = 0;
    let lastMissCount = stateRef.current?.stats.hits.miss ?? 0;
    const songMeta = loaded?.meta;

    const loop = () => {
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;

      const audio = audioRef.current;
      const state = stateRef.current;
      const songTime = audio ? audio.songTime() : -3;

      if (state && snapshot.phase === "playing") {
        state.expireMisses(songTime);
        const misses = state.stats.hits.miss;
        if (misses > lastMissCount) {
          audio?.playMiss(false);
          lastMissCount = misses;
        }

        // Score upload throttle (5 Hz) with a "no change → no send" guard
        // so an idle stretch doesn't burn bandwidth in a 50-player room.
        if (now - lastScoreSentRef.current >= SCORE_TICK_MS) {
          lastScoreSentRef.current = now;
          const sig = `${state.stats.score}|${state.stats.combo}|${state.stats.hits.miss}`;
          if (sig !== lastScoreSentSigRef.current) {
            lastScoreSentSigRef.current = sig;
            actions.sendScore(snapshotLive(state.stats, false));
          }
        }

        // End-of-song detection
        const lastNote = state.notes[state.notes.length - 1];
        const lastEnd = lastNote
          ? isHold(lastNote)
            ? (lastNote.endT as number)
            : lastNote.t
          : 0;
        const allJudged =
          lastNote &&
          songTime > lastEnd + 1.5 &&
          state.notes.every((n) => n.judged && (!isHold(n) || n.tailJudged));
        const audioDone =
          audio && !audio.isPlaying && songMeta && songTime > songMeta.duration - 0.5;
        if ((allJudged || audioDone) && !finishedRef.current) {
          finishedRef.current = true;
          const accuracy = computeAccuracy(state.stats);
          actions.sendFinished({
            score: state.stats.score,
            accuracy,
            maxCombo: state.stats.maxCombo,
            hits: state.stats.hits,
            notesPlayed: state.stats.notesPlayed,
            totalNotes: state.stats.totalNotes,
          });
          actions.sendScore(snapshotLive(state.stats, true));
        }
      }

      // Metronome scheduling matches single-player engine
      if (audio && songMeta && (snapshot.phase === "playing" || snapshot.phase === "countdown")) {
        const beatLen = 60 / songMeta.bpm;
        const lookahead = 0.6;
        const horizon = songTime + lookahead;
        const firstBeat = Math.max(0, Math.ceil((songTime - songMeta.offset) / beatLen));
        const lastBeat = Math.floor((horizon - songMeta.offset) / beatLen);
        for (let bi = firstBeat; bi <= lastBeat; bi++) {
          if (bi <= lastScheduledBeatRef.current) continue;
          const beatSongTime = songMeta.offset + bi * beatLen;
          if (beatSongTime < 0) {
            lastScheduledBeatRef.current = bi;
            continue;
          }
          // Multiplayer: metronome is ON to keep pace, but quieter (handled
          // inside the engine's scheduleClick — same code path as solo).
          audio.scheduleClick(audio.ctxTimeAt(beatSongTime), bi % 4 === 0);
          lastScheduledBeatRef.current = bi;
        }
      }

      const rs = renderStateRef.current;
      for (let i = 0; i < rs.laneFlash.length; i++) {
        rs.laneFlash[i] = Math.max(0, rs.laneFlash[i] - dt * 4.5);
      }
      if (state) rs.recentEvents = state.events;

      // Combo + milestone — same logic as single-player. The chime here is
      // local-only (each player hears their own milestones), which keeps
      // the audio bus uncluttered in a 50-player room.
      if (state) {
        const newCombo = state.stats.combo;
        rs.combo = newCombo;
        const crossed = crossedComboMilestone(prevComboRef.current, newCombo);
        if (crossed != null) {
          rs.milestone = { strength: 1, combo: crossed };
          audio?.playComboMilestone(crossed);
        }
        prevComboRef.current = newCombo;
      } else {
        rs.combo = 0;
        prevComboRef.current = 0;
      }

      renderOptsRef.current.bpm = songMeta?.bpm ?? 120;
      renderOptsRef.current.offset = songMeta?.offset ?? 0;
      renderOptsRef.current.laneHeld = heldRef.current;

      drawFrame(
        ctx,
        state ?? emptyStateRef.current,
        songTime,
        dt,
        renderOptsRef.current,
        rs,
      );

      if (state && now - lastHud > 100) {
        setStats({ ...state.stats });
        lastHud = now;
      }

      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [snapshot.phase, loaded, actions]);

  // Also need to enable AudioEngine setMetronome — we want it on by default
  // for this view (parity with single-player). Done lazily once the engine
  // exists.
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.setMetronome(true);
      audioRef.current.setVolume(0.85);
    }
  }, [loaded]);

  // Stop the engine on unmount.
  useEffect(() => {
    return () => {
      audioRef.current?.stop();
    };
  }, []);

  return (
    <div className="brut-card relative h-[60vh] min-h-[420px] w-full overflow-hidden p-0 sm:h-[68vh]">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 block h-full w-full"
      />

      {stats && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-3 p-3">
          <ScoreCard stats={stats} />
          <ComboCard stats={stats} />
        </div>
      )}

      {countdownLabel !== null && (
        <Overlay translucent>
          <div className="text-center">
            <p className="font-mono text-xs uppercase tracking-[0.4em] text-accent">
              Get ready
            </p>
            <p className="mt-2 font-display text-[clamp(6rem,18vw,12rem)] font-bold leading-none drop-shadow-[0_0_30px_rgba(61,169,255,0.6)]">
              {countdownLabel}
            </p>
            <p className="mt-2 font-mono text-xs uppercase tracking-widest text-bone-50/60">
              D F J K · or ← ↓ ↑ → · {mode} mode · scoreboard updates live
            </p>
          </div>
        </Overlay>
      )}

      {!loaded && !loadError && (
        <Overlay>
          <div className="brut-card-accent flex items-center gap-3 p-5">
            <Spinner />
            <p className="font-mono text-xs uppercase tracking-widest text-bone-50/80">
              waiting for chart…
            </p>
          </div>
        </Overlay>
      )}

      {loadError && !loaded && (
        <Overlay>
          <div className="brut-card-accent max-w-md p-5 text-center">
            <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-rose-400">
              ✕ Couldn&apos;t load
            </p>
            <p className="mt-2 font-mono text-xs text-bone-50/80">
              {loadError}
            </p>
            <p className="mt-2 font-mono text-[10px] uppercase tracking-widest text-bone-50/40">
              Hang tight — host can cancel back to the lobby.
            </p>
          </div>
        </Overlay>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Sidebar scoreboard                                                       */
/* ------------------------------------------------------------------------ */

function ScoreboardSidebar({
  scoreboard,
  me,
  snapshot,
}: {
  scoreboard: ScoreboardEntry[];
  me: string;
  snapshot: RoomSnapshot;
}) {
  // Fall back to building entries from the snapshot when the scoreboard
  // event hasn't arrived yet (very first frame after countdown).
  const entries =
    scoreboard.length > 0
      ? scoreboard
      : snapshot.players.map((p) => ({
          id: p.id,
          name: p.name,
          score: p.live.score,
          combo: p.live.combo,
          accuracy: p.live.accuracy,
          online: p.online,
          finished: p.live.finished,
        }));

  return (
    <aside className="brut-card flex max-h-[68vh] flex-col p-4 sm:p-5">
      <div className="flex items-baseline justify-between gap-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-accent">
          ░ Live
        </p>
        <span className="font-mono text-[10px] uppercase tracking-widest text-bone-50/40">
          {entries.filter((e) => e.online).length} online
        </span>
      </div>
      <ol className="mt-3 flex-1 space-y-1.5 overflow-y-auto pr-1">
        {entries.map((e, i) => {
          const isMe = e.id === me;
          return (
            <li
              key={e.id}
              className={`flex items-center gap-2 border-2 px-2.5 py-1.5 font-mono transition-colors ${
                isMe
                  ? "border-accent bg-accent/10"
                  : e.finished
                    ? "border-bone-50/30"
                    : "border-bone-50/10"
              }`}
            >
              <span
                className={`w-5 shrink-0 text-center text-[10px] uppercase tracking-widest ${
                  i === 0 ? "text-accent" : "text-bone-50/40"
                }`}
              >
                {i + 1}
              </span>
              <span
                className="min-w-0 flex-1 truncate text-xs"
                title={e.name}
              >
                {e.name}
                {isMe && (
                  <span className="ml-1 text-[9px] uppercase text-accent">
                    you
                  </span>
                )}
              </span>
              {/* Live combo badge — makes the sidebar feel like a race
                  even when scores are close. Only shown for non-finished
                  players (finished rows show the ✓ mark instead). */}
              {!e.finished && e.combo > 0 && (
                <span
                  className={`shrink-0 px-1 text-[9px] tabular-nums tracking-widest ${
                    e.combo >= 50
                      ? "text-accent"
                      : e.combo >= 10
                        ? "text-bone-50/70"
                        : "text-bone-50/40"
                  }`}
                  title={`Combo ×${e.combo}`}
                >
                  ×{e.combo}
                </span>
              )}
              <span className="shrink-0 text-right text-[11px] tabular-nums text-bone-50">
                {e.score.toLocaleString()}
              </span>
              {e.finished && (
                <span
                  className="shrink-0 text-[9px] uppercase tracking-widest text-accent"
                  title="Finished"
                >
                  ✓
                </span>
              )}
              {!e.online && (
                <span
                  className="shrink-0 text-[9px] uppercase tracking-widest text-bone-50/30"
                  title="Disconnected"
                >
                  ⌀
                </span>
              )}
            </li>
          );
        })}
      </ol>
      <p className="mt-3 border-t-2 border-bone-50/10 pt-2 font-mono text-[9px] uppercase tracking-widest text-bone-50/40">
        Updates ~5×/sec · everyone races on the same chart
      </p>
    </aside>
  );
}

/* ------------------------------------------------------------------------ */
/* HUD bits                                                                 */
/* ------------------------------------------------------------------------ */

function ScoreCard({ stats }: { stats: PlayerStats }) {
  const accuracy = computeAccuracy(stats);
  return (
    <div className="brut-card-accent px-3 py-2 min-w-[150px]">
      <p className="font-mono text-[9px] uppercase tracking-widest text-bone-50/60">
        Score
      </p>
      <p className="font-display text-2xl font-bold leading-none">
        {stats.score.toLocaleString()}
      </p>
      <p className="mt-0.5 font-mono text-[9px] text-bone-50/60">
        {accuracy.toFixed(1)}% · {stats.notesPlayed}/{stats.totalNotes}
      </p>
    </div>
  );
}

function ComboCard({ stats }: { stats: PlayerStats }) {
  return (
    <div className="brut-card flex flex-col items-center px-3 py-2 min-w-[100px]">
      <p className="font-mono text-[9px] uppercase tracking-widest text-bone-50/60">
        Combo
      </p>
      <p
        className={`font-display text-2xl font-bold leading-none ${
          stats.combo > 0 ? "text-accent" : "text-bone-50/40"
        }`}
      >
        {stats.combo}
      </p>
      <p className="mt-0.5 font-mono text-[9px] font-bold text-accent">
        ×{stats.multiplier}
      </p>
    </div>
  );
}

function Overlay({
  children,
  translucent,
}: {
  children: React.ReactNode;
  translucent?: boolean;
}) {
  return (
    <div
      className={`absolute inset-0 z-20 flex items-center justify-center px-4 ${
        translucent ? "bg-ink-900/40 backdrop-blur-sm" : "bg-ink-900/80 backdrop-blur"
      }`}
    >
      {children}
    </div>
  );
}

function Spinner() {
  return (
    <span
      role="status"
      aria-label="Loading"
      className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-bone-50/20 border-t-accent"
    />
  );
}

/* ------------------------------------------------------------------------ */
/* Helpers                                                                  */
/* ------------------------------------------------------------------------ */

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable;
}

function computeAccuracy(stats: PlayerStats): number {
  const total = stats.notesPlayed || 1;
  return (
    ((stats.hits.perfect + stats.hits.great * 0.7 + stats.hits.good * 0.4) /
      total) *
    100
  );
}

function snapshotLive(stats: PlayerStats, finished: boolean): LiveScore {
  return {
    score: stats.score,
    combo: stats.combo,
    maxCombo: stats.maxCombo,
    accuracy: computeAccuracy(stats),
    notesPlayed: stats.notesPlayed,
    totalNotes: stats.totalNotes,
    hits: stats.hits,
    health: stats.health,
    finished,
  };
}

// Suppress unused-import warning for ArrowIcon — kept here for future icons
// (back-to-lobby on results / etc) without re-importing.
void ArrowIcon;
