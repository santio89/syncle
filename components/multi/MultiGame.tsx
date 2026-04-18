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
import { loadVolume, saveVolume } from "@/lib/game/settings";
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
  // Full-bleed layout: the canvas fills the available area exactly like
  // single-player, with the live scoreboard floating as a right-edge overlay.
  // This makes the multiplayer view feel like the same game, not a smaller
  // boxed-in version of it.
  return (
    <div className="relative h-full w-full">
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
  // Audio + perf controls — same model as single-player. Metronome stays
  // user-toggleable here too (it only affects the LOCAL click track; the
  // server-driven `startsAt` timestamp is what actually keeps the room in
  // sync, not whether each player happens to hear the metronome).
  const [volume, setVolume] = useState<number>(0.85);
  const [metronome, setMetronome] = useState<boolean>(true);
  const [fps, setFps] = useState<number>(0);
  /**
   * Flips true once `loadFromBytes` / `load` resolves and the AudioBuffer
   * is actually decoded into the engine. The schedule effect depends on
   * this so it re-runs the moment the buffer is ready — without it, if the
   * snapshot's `startsAt` arrived BEFORE the buffer finished loading,
   * `audio.start()` would throw, get silently caught, and `songTime()`
   * would then track `ctx.currentTime` (positive, growing) instead of the
   * intended negative countdown value. That bug surfaced as random notes
   * appearing on the highway during the "3, 2, 1" overlay.
   */
  const [audioReady, setAudioReady] = useState(false);

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
    // Re-arm the readiness gate so the schedule effect doesn't reuse the
    // previous song's "ready" signal while the new buffer is still
    // decoding (matters when the host picks a fresh song after a results
    // screen).
    setAudioReady(false);
    const prep = async () => {
      let buffered = false;
      try {
        if (!audioRef.current) audioRef.current = new AudioEngine();
        audioRef.current.ensureContext();
        if (loaded.delivery === "remote" && loaded.audioBytes && loaded.audioKey) {
          await audioRef.current.loadFromBytes(
            loaded.audioBytes.slice(0),
            loaded.audioKey,
          );
          buffered = true;
        } else if (loaded.meta.audioUrl) {
          await audioRef.current.load(loaded.meta.audioUrl);
          buffered = true;
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
      if (buffered) setAudioReady(true);
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
    // Wait for both: chart loaded AND audio buffer decoded. Without the
    // `audioReady` gate, this effect can fire while the buffer is still
    // decoding — `audio.start()` would then throw, leave
    // `startedAtCtxTime = 0`, and the next frame's `songTime()` would
    // return raw `ctx.currentTime` (positive), making the renderer draw
    // notes from random points in the chart over the countdown overlay.
    if (!loaded || !audioRef.current || !audioReady) return;
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
        // Belt-and-suspenders: in the unlikely case start() still throws
        // (e.g. context suspended by the browser), we'll re-fire once the
        // user interacts and the audio context resumes.
      }
    };
    schedule();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioReady, loaded, snapshot.startsAt, snapshot.songStartedAt]);

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
    // FPS sampling — same 500ms window as Game.tsx.
    let fpsAccumStart = last;
    let fpsAccumFrames = 0;
    const songMeta = loaded?.meta;

    const loop = () => {
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;

      fpsAccumFrames++;
      if (now - fpsAccumStart >= 500) {
        setFps(Math.round((fpsAccumFrames * 1000) / (now - fpsAccumStart)));
        fpsAccumFrames = 0;
        fpsAccumStart = now;
      }

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

      // Render the highway empty during countdown. Even with the audio
      // race fixed, charts that start with notes inside `leadTime` (1.2s)
      // would briefly pop a few notes onto the screen behind the "3 / 2 /
      // 1" overlay. Drawing the empty state here keeps the countdown
      // visually pristine: lane gates + grid + held-key glows still
      // animate (those read off `rs`, not the chart), only chart notes
      // are suppressed until phase flips to "playing".
      const drawState =
        snapshot.phase === "countdown"
          ? emptyStateRef.current
          : (state ?? emptyStateRef.current);
      drawFrame(
        ctx,
        drawState,
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

  // Mirror React state into the AudioEngine. `loaded` is in the dep list
  // for both effects so the values get re-applied as soon as the engine
  // finishes (re)initializing for a new song — otherwise toggling
  // metronome / dragging the volume slider before the engine spun up
  // would silently drop the value.
  useEffect(() => {
    audioRef.current?.setMetronome(metronome);
  }, [metronome, loaded]);

  useEffect(() => {
    audioRef.current?.setVolume(volume);
    saveVolume(volume);
  }, [volume, loaded]);

  // Hydrate persisted volume on mount so the slider remembers the last
  // session's preference (shared with single-player via lib/game/settings).
  useEffect(() => {
    setVolume(loadVolume());
  }, []);

  // Stop the engine on unmount.
  useEffect(() => {
    return () => {
      audioRef.current?.stop();
    };
  }, []);

  return (
    <div className="absolute inset-0">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 block h-full w-full"
      />

      {stats && (
        // Same combined SCORE+COMBO panel as single-player, with the rock
        // meter card stacked directly underneath. The wrapping column is
        // `w-fit` so it shrinks to the wider of its two children (the
        // performance panel), and the rock meter then uses `w-full` to
        // match it pixel-for-pixel — that's what the user sees as "the
        // rock meter is as wide as the score container above".
        // Pause is intentionally absent (multi can't pause without
        // freezing 50 other players); metronome + volume + fps stay so
        // the player keeps the same audio controls they have in solo.
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 mx-auto flex w-full max-w-6xl items-start gap-3 p-3 sm:p-5">
          <div className="flex w-fit flex-col gap-3">
            <PerformancePanel stats={stats} />
            <HealthPanel
              stats={stats}
              volume={volume}
              onVolume={setVolume}
              metronome={metronome}
              onToggleMetronome={() => setMetronome((m) => !m)}
              fps={fps}
            />
          </div>
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
    // The scoreboard is right-aligned inside the SAME `max-w-6xl` band that
    // bounds the score/combo cluster (and that bounds the rock-meter card
    // in single-player). On wide screens this pulls the panel inwards so
    // both side overlays sit close to the highway, matching the
    // single-player feel; on narrow viewports the band collapses to the
    // screen width and the scoreboard ends up flush against the right
    // padding, which is the right behaviour there too.
    //
    // The wrapper is `pointer-events-none` so it doesn't trap pointer
    // events over empty highway space, but the `<aside>` re-enables them
    // for the actual scoreboard surface.
    //
    // Sizing for full rooms (up to 50 players):
    //   - Width: fixed 280–320px so player names always fit, never
    //     widening past 40vw on narrow screens.
    //   - Height: `max-h-[calc(100%-...)]` so the panel can grow with the
    //     player count up to "almost the full canvas height", but never
    //     past the canvas. The inner <ol> has `overflow-y-auto`, so when
    //     50 players push past that ceiling the rows scroll INSIDE the
    //     panel and never leak into the gameplay area.
    <div className="pointer-events-none absolute inset-0 z-10 mx-auto w-full max-w-6xl">
      <aside
        className="brut-card pointer-events-auto absolute right-3 top-3 flex max-h-[calc(100%-1.5rem)] w-[280px] max-w-[40vw] flex-col p-4 sm:right-5 sm:top-5 sm:max-h-[calc(100%-2.5rem)] sm:w-[320px] sm:p-5"
      >
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
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* HUD bits                                                                 */
/* ------------------------------------------------------------------------ */

function PerformancePanel({ stats }: { stats: PlayerStats }) {
  const accuracy = computeAccuracy(stats);
  return (
    <div className="brut-card-accent flex items-stretch gap-4 px-4 py-3">
      <div className="min-w-[150px]">
        <p className="font-mono text-[10px] uppercase tracking-widest text-bone-50/60">
          Score
        </p>
        <p className="font-display text-2xl sm:text-3xl font-bold leading-none">
          {stats.score.toLocaleString()}
        </p>
        <p className="mt-1 font-mono text-[10px] text-bone-50/60">
          {accuracy.toFixed(1)}% · {stats.notesPlayed}/{stats.totalNotes}
        </p>
      </div>
      <div className="w-px shrink-0 bg-bone-50/20" aria-hidden />
      <div className="flex min-w-[80px] flex-col items-center justify-center">
        <p className="font-mono text-[10px] uppercase tracking-widest text-bone-50/60">
          Combo
        </p>
        <p
          className={`font-display text-3xl sm:text-4xl font-bold leading-none tabular-nums ${
            stats.combo > 0 ? "text-accent" : "text-bone-50/40"
          }`}
        >
          {stats.combo}
        </p>
        <p className="mt-1 font-mono text-xs font-bold text-accent">
          ×{stats.multiplier}
        </p>
      </div>
    </div>
  );
}

/**
 * Multiplayer rock-meter card — visually identical to the single-player
 * one (health bar + hit tally + metronome toggle + volume slider + FPS),
 * deliberately MINUS the pause button since multi can't pause without
 * freezing the rest of the room. `w-full` so the card stretches to match
 * the score+combo panel above (the parent column is `w-fit`).
 */
function HealthPanel({
  stats,
  volume,
  onVolume,
  metronome,
  onToggleMetronome,
  fps,
}: {
  stats: PlayerStats;
  volume: number;
  onVolume: (v: number) => void;
  metronome: boolean;
  onToggleMetronome: () => void;
  fps: number;
}) {
  const healthColor =
    stats.health > 0.6
      ? "#3dff8a"
      : stats.health > 0.3
        ? "#ffd23f"
        : "#ff3b6b";
  return (
    <div className="brut-card flex w-full flex-col gap-1 px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <p className="font-mono text-[10px] uppercase tracking-widest text-bone-50/60">
          Rock meter
        </p>
        <button
          onClick={onToggleMetronome}
          className={`pointer-events-auto font-mono text-[9px] uppercase tracking-widest border px-1.5 py-0.5 transition-colors ${
            metronome
              ? "border-accent text-accent"
              : "border-bone-50/30 text-bone-50/40"
          }`}
          title="Toggle metronome (local only)"
        >
          ♩ {metronome ? "ON" : "OFF"}
        </button>
      </div>
      <div className="relative h-3 w-full border-2 border-bone-50/40">
        <div
          className="absolute inset-y-0 left-0 transition-[width] duration-200"
          style={{
            width: `${stats.health * 100}%`,
            background: healthColor,
          }}
        />
      </div>
      <p className="font-mono text-[10px] text-bone-50/60">
        P{stats.hits.perfect} · G{stats.hits.great} · g{stats.hits.good} · M
        {stats.hits.miss}
      </p>
      <div className="mt-1 flex items-center gap-2">
        <span className="font-mono text-[9px] uppercase tracking-widest text-bone-50/50">
          vol
        </span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={(e) => onVolume(parseFloat(e.target.value))}
          className="pointer-events-auto h-1 flex-1 cursor-pointer accent-accent"
          aria-label="Music volume"
        />
        <span className="font-mono text-[9px] tabular-nums text-bone-50/40 w-7 text-right">
          {Math.round(volume * 100)}
        </span>
      </div>
      <div className="flex items-center justify-end">
        <span
          className={`font-mono text-[9px] tabular-nums tracking-widest ${
            fps >= 55
              ? "text-bone-50/40"
              : fps >= 40
                ? "text-amber-400/70"
                : "text-rose-400/80"
          }`}
        >
          {fps} fps
        </span>
      </div>
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
