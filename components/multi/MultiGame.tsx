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
import { displayMode, modeStars } from "@/lib/game/chart";
import {
  loadVolume,
  saveVolume,
  loadSfx,
  saveSfx,
  loadMetronome,
  saveMetronome,
  loadFpsLock,
  saveFpsLock,
  nextFpsLock,
  type FpsLock,
} from "@/lib/game/settings";
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
import {
  MATCH_LEAD_IN_MS,
  type LiveScore,
  type RoomSnapshot,
  type ScoreboardEntry,
} from "@/lib/multi/protocol";

const KEY_TO_LANE: Record<string, number> = {
  KeyD: 0, ArrowLeft: 0,
  KeyF: 1, ArrowDown: 1,
  KeyJ: 2, ArrowUp: 2,
  KeyK: 3, ArrowRight: 3,
};

const SCORE_TICK_MS = 200; // 5 Hz

/**
 * Same value as the server's `MATCH_LEAD_IN_MS` but expressed in
 * seconds for the in-render math (songTime is in seconds). Used to (a)
 * hide the "3 / 2 / 1" overlay this many seconds before audio starts so
 * the player gets a silent runway, and (b) flip the highway from
 * `emptyState` to the real chart inside that window so notes whose
 * onset falls inside `leadTime` (1.2 s) can spawn naturally instead of
 * popping in at the strike line the instant the song begins.
 */
const MATCH_LEAD_IN_SECONDS = MATCH_LEAD_IN_MS / 1000;

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
  /**
   * Flips true the first time the schedule effect successfully calls
   * `audio.start()`. Before that flip, `audioRef.current?.songTime()`
   * returns `ctx.currentTime - 0` (positive, growing) because
   * `startedAtCtxTime` defaults to 0 — useless as a chart clock. The
   * highway-gating logic in the rAF loop reads this ref to know when
   * `songTime()` is trustworthy for the "should we draw the real
   * chart yet?" decision during the silent lead-in window.
   */
  const audioStartedRef = useRef<boolean>(false);

  const [stats, setStats] = useState<PlayerStats | null>(null);
  // Throttled song-progress fraction (0..1) for the rock-meter card's
  // progress bar. Mirrors the single-player Game.tsx pattern — written
  // alongside `setStats` from inside the rAF loop so it ticks at the
  // same ~10Hz cadence (smooth without re-rendering every vblank).
  const [songProgress, setSongProgress] = useState<number>(0);
  const [countdownLabel, setCountdownLabel] = useState<number | null>(null);
  // Audio + perf controls — same model as single-player. Metronome stays
  // user-toggleable here too (it only affects the LOCAL click track; the
  // server-driven `startsAt` timestamp is what actually keeps the room in
  // sync, not whether each player happens to hear the metronome).
  // Settings that live in localStorage are read via lazy `useState`
  // initializers so the very first render already reflects what the
  // player saved last session — no flash of defaults, no `useEffect`
  // hydration round-trip. MultiGame only mounts after the lobby
  // (countdown / playing phase), so these initializers always run on
  // the client; `loadX()` falls back to the hardcoded default if
  // `window` is missing anyway.
  const [volume, setVolume] = useState<number>(loadVolume);
  const [metronome, setMetronome] = useState<boolean>(loadMetronome);
  // Per-input feedback SFX (hit / miss / release / combo-milestone +
  // the song-duck whiff cue). Persisted via the same shared
  // settings store as solo so a player's preference carries across
  // game modes. The engine no-ops the relevant `play*` calls when
  // off — song bus + metronome stay live.
  const [sfx, setSfx] = useState<boolean>(loadSfx);
  const [fps, setFps] = useState<number>(0);
  // Optional render-loop frame-rate cap — same control surface as
  // single-player (off / 30 / 60), shared persistence key so a player
  // who caps in solo also has it capped in multi without re-toggling.
  const [fpsLock, setFpsLock] = useState<FpsLock>(loadFpsLock);
  const fpsLockRef = useRef<FpsLock>(loadFpsLock());
  useEffect(() => {
    fpsLockRef.current = fpsLock;
  }, [fpsLock]);
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
    // Re-arm the "audio actually started" flag too — a fresh chart in
    // the same room means the next `audio.start()` call is the new
    // ground truth for songTime, and until then the highway gating
    // logic shouldn't trust the engine's clock.
    audioStartedRef.current = false;
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
        // Mark the audio engine's clock as trustworthy now that
        // `start()` has anchored `startedAtCtxTime` to the right
        // moment. The rAF loop reads this when deciding whether to
        // believe `songTime()` for highway gating during the silent
        // lead-in window.
        audioStartedRef.current = true;
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

  // Countdown overlay tick.
  //
  // The server's `startsAt` is when audio actually fires; the visible
  // "3 / 2 / 1" overlay should END `MATCH_LEAD_IN_MS` BEFORE that so
  // the player sees:
  //   - first 3 s → overlay counts down 3, 2, 1
  //   - next  2 s → overlay gone, highway scrolls empty (lead-in)
  //   - then       → audio starts + notes start arriving
  // Subtracting the lead-in here is what gives us the silent runway
  // without changing the audio schedule (the schedule effect below
  // still aims for `startsAt` exactly, so server + client + everyone
  // else's audio remain phase-locked).
  useEffect(() => {
    if (snapshot.phase !== "countdown" || !snapshot.startsAt) {
      setCountdownLabel(null);
      return;
    }
    const overlayDeadline = snapshot.startsAt - MATCH_LEAD_IN_MS;
    const tick = () => {
      const remaining = (overlayDeadline - Date.now()) / 1000;
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
  // Same single-source-of-truth pattern as single-player Game.tsx:
  // pressLane / releaseLane are stable callbacks consumed by both the
  // keyboard listener and the on-screen <TouchLanes> overlay, so hold
  // notes work identically across input devices.
  const phaseRef = useRef(snapshot.phase);
  useEffect(() => {
    phaseRef.current = snapshot.phase;
  }, [snapshot.phase]);

  const pressLane = useCallback((lane: number) => {
    if (phaseRef.current === "results") return;
    heldRef.current[lane] = true;
    if (phaseRef.current !== "playing") return;
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
  }, []);

  const releaseLane = useCallback((lane: number) => {
    if (phaseRef.current === "results") return;
    heldRef.current[lane] = false;
    if (phaseRef.current !== "playing") return;
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
  }, []);

  useEffect(() => {
    if (snapshot.phase !== "playing" && snapshot.phase !== "countdown") return;
    const onKeyDown = (e: KeyboardEvent) => {
      // Skip when the user is typing in a form field (future chat, name
      // change, etc). Same guard as single-player Game.tsx.
      if (isEditableTarget(e.target)) return;
      // M = metronome, N = input feedback SFX. Both are local-only
      // toggles (don't affect other players in the room) so binding
      // them here mirrors the single-player HUD without any room
      // protocol implications. Sit above the lane lookup so a player
      // who happens to bind M/N as a lane in the future doesn't
      // shadow the meta toggles.
      if (e.code === "KeyM") {
        setMetronome((m) => !m);
        e.preventDefault();
        return;
      }
      if (e.code === "KeyN") {
        setSfx((s) => !s);
        e.preventDefault();
        return;
      }
      const lane = KEY_TO_LANE[e.code];
      if (lane === undefined) return;
      if (e.repeat) return;
      e.preventDefault();
      pressLane(lane);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      const lane = KEY_TO_LANE[e.code];
      if (lane === undefined) return;
      releaseLane(lane);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [snapshot.phase, pressLane, releaseLane]);

  /* -------- coarse-pointer detection (drives the <TouchLanes> overlay) ---- */
  const [touchOnly, setTouchOnly] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    const noFine = !window.matchMedia("(any-pointer: fine)").matches;
    setTouchOnly(coarse && noFine);
  }, []);

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

    // Drift-corrected pacing for the optional FPS cap. See Game.tsx
    // for the long-form rationale; in short, we advance the schedule
    // by exactly one interval (not by `now`) so vblank rounding error
    // cancels out across frames. Keeps "lock 60" at 60 fps on a
    // 200Hz display instead of rounding up to the next vblank
    // multiple (= 50 fps), and "lock 30" at 30 instead of ~28.5.
    let pacedNext = performance.now();
    let pacedLastLock: FpsLock | undefined = undefined;

    const loop = () => {
      const now = performance.now();
      const lockedFps = fpsLockRef.current;
      // Score upload + finished detection live inside the gated body,
      // but the room is driven by server-authoritative timestamps so
      // missing a couple of intermediate ticks per second never
      // affects the actual sync. Audio runs off AudioContext, not
      // rAF, so capping render rate is safe.
      if (lockedFps != null) {
        const interval = 1000 / lockedFps;
        if (pacedLastLock !== lockedFps) {
          pacedNext = now;
          pacedLastLock = lockedFps;
        }
        if (now < pacedNext) {
          rafRef.current = requestAnimationFrame(loop);
          return;
        }
        pacedNext += interval;
        if (pacedNext < now) pacedNext = now + interval;
      } else if (pacedLastLock !== null) {
        pacedNext = now;
        pacedLastLock = null;
      }
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
      // Read phase off the ref so this loop doesn't have to be a dep of
      // the effect — that's what keeps the same rAF + audio engine alive
      // across the countdown → playing transition (otherwise the loop
      // tore itself down at the moment the song actually started, which
      // also reset `last` / `pacedNext` and produced a visible stutter
      // on the first frame of audio).
      const currentPhase = phaseRef.current;

      if (state && currentPhase === "playing") {
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
      if (audio && songMeta && (currentPhase === "playing" || currentPhase === "countdown")) {
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

      // Highway gating across the match-start window:
      //
      //   [overlay]  songTime < -LEAD_IN  → emptyState
      //              "3 / 2 / 1" is on screen; chart notes that fall
      //              inside the renderer's `leadTime` (1.2s) would
      //              otherwise flash through the overlay's translucent
      //              backing.
      //
      //   [lead-in]  -LEAD_IN ≤ songTime < 0 → real state
      //              Overlay is gone, audio not yet playing, but we
      //              WANT the highway showing the real chart so any
      //              note at t<leadTime can spawn at the top of the
      //              highway and slide down naturally — that's what
      //              gives the player the "board sliding as I prepare"
      //              feel they're after instead of notes popping in
      //              at the strike line the instant the song begins.
      //
      //   [playing]  songTime ≥ 0 → real state (steady-state).
      //
      // Falls back to emptyState whenever the audio engine isn't
      // armed yet (audio not loaded / `audio.start()` not yet called),
      // because before `start()` runs `songTime()` returns
      // `ctx.currentTime` (positive, growing) which would draw notes
      // from random points in the chart.
      const audioArmed = audioStartedRef.current;
      const inLeadInOrPlaying =
        audioArmed && songTime >= -MATCH_LEAD_IN_SECONDS;
      const drawState =
        currentPhase === "countdown"
          ? inLeadInOrPlaying
            ? (state ?? emptyStateRef.current)
            : emptyStateRef.current
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
        if (songMeta && songMeta.duration > 0) {
          // Clamp to [0..1] — `songTime` runs negative during the
          // server-synced lead-in and can briefly exceed `duration`
          // while the audio buffer drains at the tail.
          const frac = songTime / songMeta.duration;
          setSongProgress(frac < 0 ? 0 : frac > 1 ? 1 : frac);
        }
        lastHud = now;
      }

      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
    // Intentional: `snapshot.phase` is read via `phaseRef` inside the
    // loop so this effect never restarts on phase changes (which would
    // cancel + re-create the rAF, reset pacing, and stutter the first
    // frame after countdown). `actions` is now memoized in the hook so
    // including it here is referentially stable for the room's
    // lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, actions]);

  // Mirror React state into the AudioEngine and persist it. `loaded`
  // is in the dep list for the engine-mirror effects so the values
  // get re-applied as soon as the engine finishes (re)initializing
  // for a new song — otherwise toggling metronome / dragging the
  // volume slider before the engine spun up would silently drop the
  // value.
  //
  // Persistence rides along: because the lazy `useState(loadX)`
  // initializers above already seed state from storage, the first
  // fire of these effects writes the same value back — a harmless
  // no-op that keeps the contract simple (no hydration gate, no
  // separate `useEffect` to "load" later, no flash of defaults). All
  // four settings share the same store as single-player via
  // `lib/game/settings` so a player who tweaks them in solo also has
  // them carried over into multi without re-toggling.
  useEffect(() => {
    audioRef.current?.setMetronome(metronome);
    saveMetronome(metronome);
  }, [metronome, loaded]);

  useEffect(() => {
    audioRef.current?.setVolume(volume);
    saveVolume(volume);
  }, [volume, loaded]);

  useEffect(() => {
    audioRef.current?.setSfx(sfx);
    saveSfx(sfx);
  }, [sfx, loaded]);

  // Persist the FPS lock — the rAF loop reads `fpsLockRef`, so this is
  // purely about remembering the choice across reconnects / refreshes.
  useEffect(() => {
    saveFpsLock(fpsLock);
  }, [fpsLock]);

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
        // Layout band mirrors the single-player HUD:
        //   - `max-w-7xl` lets the left column drift outward on big monitors
        //     so it doesn't get pulled tight against the centered band.
        //   - `sm:px-3` (was sm:p-5) hugs the left edge on narrower laptops
        //     so the score/combo and rock-meter cards have more pixels
        //     between them and the highway's widening trapezoid.
        //   - Vertical `sm:py-5` keeps the original top inset.
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 mx-auto flex w-full max-w-7xl items-start gap-3 p-3 sm:py-5 sm:px-3">
          {/* Bump the gap between the performance and settings cards
              so the two boxes read as distinct panels instead of
              one tall stack glued together. `gap-5` (20 px) on
              desktop gives them clear visual separation; the
              smaller `gap-3` (12 px) on mobile keeps the column
              from eating too much vertical real estate on short
              landscape phones. */}
          <div className="flex w-fit flex-col gap-3 sm:gap-5">
            <PerformancePanel
              stats={stats}
              chartMode={mode}
              songDuration={loaded?.meta.duration ?? null}
            />
            <HealthPanel
              stats={stats}
              volume={volume}
              onVolume={setVolume}
              metronome={metronome}
              onToggleMetronome={() => setMetronome((m) => !m)}
              sfx={sfx}
              onToggleSfx={() => setSfx((s) => !s)}
              fps={fps}
              fpsLock={fpsLock}
              onCycleFpsLock={() => setFpsLock((cur) => nextFpsLock(cur))}
              songTitle={loaded?.meta.title ?? snapshot.selectedSong?.title ?? null}
              songArtist={loaded?.meta.artist ?? snapshot.selectedSong?.artist ?? null}
              songDuration={loaded?.meta.duration ?? null}
              songProgress={songProgress}
            />
          </div>
        </div>
      )}

      {countdownLabel !== null && (
        <Overlay translucent>
          <div className="text-center">
            <p className="font-mono text-[0.79rem] uppercase tracking-[0.4em] text-accent">
              Get ready
            </p>
            <p className="mt-2 font-display text-[clamp(6.3rem,18.9vw,12.6rem)] font-bold leading-none drop-shadow-[0_0_30px_rgba(61,169,255,0.6)]">
              {countdownLabel}
            </p>
            <p className="mt-2 font-mono text-[0.79rem] uppercase tracking-widest text-bone-50/60">
              {touchOnly ? "tap the lanes" : "D F J K · or ← ↓ ↑ →"} · {displayMode(mode)} mode · scoreboard updates live
            </p>
          </div>
        </Overlay>
      )}

      {!loaded && !loadError && (
        <Overlay>
          <div className="brut-card-accent flex items-center gap-3 p-5">
            <Spinner />
            <p className="font-mono text-[0.79rem] uppercase tracking-widest text-bone-50/80">
              waiting for chart…
            </p>
          </div>
        </Overlay>
      )}

      {loadError && !loaded && (
        <Overlay>
          <div className="brut-card-accent max-w-md p-5 text-center">
            <p className="font-mono text-[10.5px] uppercase tracking-[0.4em] text-rose-400">
              ✕ Couldn&apos;t load
            </p>
            <p className="mt-2 font-mono text-[0.79rem] text-bone-50/80">
              {loadError}
            </p>
            <p className="mt-2 font-mono text-[10.5px] uppercase tracking-widest text-bone-50/40">
              Hang tight — host can cancel back to the lobby.
            </p>
          </div>
        </Overlay>
      )}

      {/* Touch lane buttons — same component shape as single-player. Only
          shown for coarse pointers, only during countdown/playing. */}
      {touchOnly &&
        (snapshot.phase === "countdown" || snapshot.phase === "playing") && (
          <TouchLanes onPress={pressLane} onRelease={releaseLane} />
        )}
    </div>
  );
}

/**
 * On-screen lane buttons for touch devices — see Game.tsx::TouchLanes for
 * the full rationale (pointer capture, touch-action, multi-touch holds).
 * Duplicated here rather than imported to avoid coupling the multiplayer
 * canvas pane to the single-player module.
 */
function TouchLanes({
  onPress,
  onRelease,
}: {
  onPress: (lane: number) => void;
  onRelease: (lane: number) => void;
}) {
  const colors = ["#ff3b6b", "#ffd23f", "#3dff8a", "#3da9ff"];
  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-0 top-1/3 z-10 grid grid-cols-4 select-none"
      aria-hidden
    >
      {[0, 1, 2, 3].map((lane) => (
        <button
          key={lane}
          type="button"
          aria-label={`Lane ${lane + 1}`}
          className="pointer-events-auto relative h-full w-full border-t-2 border-bone-50/10 bg-transparent transition-colors duration-75 active:bg-white/10"
          style={{
            touchAction: "none",
            WebkitTapHighlightColor: "transparent",
            borderTopColor: `${colors[lane]}33`,
          }}
          onPointerDown={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLButtonElement).setPointerCapture(
              e.pointerId,
            );
            onPress(lane);
          }}
          onPointerUp={(e) => {
            e.preventDefault();
            const el = e.currentTarget as HTMLButtonElement;
            if (el.hasPointerCapture(e.pointerId)) {
              el.releasePointerCapture(e.pointerId);
            }
            onRelease(lane);
          }}
          onPointerCancel={(e) => {
            const el = e.currentTarget as HTMLButtonElement;
            if (el.hasPointerCapture(e.pointerId)) {
              el.releasePointerCapture(e.pointerId);
            }
            onRelease(lane);
          }}
          onContextMenu={(e) => e.preventDefault()}
        />
      ))}
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
    // The scoreboard is right-aligned inside the SAME `max-w-7xl` band that
    // bounds the score/combo cluster (and that bounds the rock-meter card
    // in single-player). On wide screens this pulls the panel inwards so
    // both side overlays sit close to (but never on top of) the highway,
    // matching the single-player feel; on narrow viewports the band
    // collapses to the screen width and the scoreboard ends up flush
    // against the right padding, which is the right behaviour there too.
    // The band was widened from 6xl → 7xl together with the highway-half
    // shrink (264 in renderer.ts) so big-monitor users see the scoreboard
    // sit ~50 px clear of the highway's bottom-right corner instead of
    // grazing it.
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
    <div className="pointer-events-none absolute inset-0 z-10 mx-auto w-full max-w-7xl">
      {/* Scoreboard widths step up with viewport so it never crowds the
          highway:
            - default (mobile / narrow tablet): 240 px, capped further by
              `max-w-[40vw]` so it never eats more than a screen-half.
            - sm  (≥ 640 px laptops): 264 px  — fits beside the shrunk
              highway with a few px of breathing room on common 1024 px
              viewports.
            - lg  (≥ 1024 px desktops): 288 px — restores room for long
              player names once the highway has plenty of side area.
            - xl  (≥ 1280 px monitors): 310 px — original full-size band.
          The right-3 sm:right-3 lg:right-5 ladder keeps the panel hugging
          the screen edge on small screens (where every px of side area
          counts) and only adds the original 20 px of breathing room on
          lg+ where the band stops growing relative to the highway. */}
      <aside
        className="brut-card pointer-events-auto absolute right-3 top-3 flex max-h-[calc(100%-1.5rem)] w-[240px] max-w-[40vw] flex-col p-4 sm:right-3 sm:top-5 sm:max-h-[calc(100%-2.5rem)] sm:w-[264px] sm:p-5 lg:right-5 lg:w-[288px] xl:w-[310px]"
      >
      <div className="flex items-baseline justify-between gap-3">
        <p className="font-mono text-[10.2px] uppercase tracking-[0.4em] text-accent">
          ░ Live
        </p>
        <span className="font-mono text-[10.2px] uppercase tracking-widest text-bone-50/40">
          {entries.filter((e) => e.online).length} online
        </span>
      </div>
      {/* Same cap as the lobby roster (~6-7 rows) so the live scoreboard
          stays compact even on tall viewports — keeps the panel from
          stretching down to the gameplay canvas ceiling on a 4K monitor
          when a 50-player room is full. The brutalist scrollbar (wired
          globally in globals.css) takes over once the cap is hit. */}
      <ol className="mt-3 max-h-72 flex-1 space-y-1.5 overflow-y-auto pr-1">
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
                className={`w-5 shrink-0 text-center text-[10.2px] uppercase tracking-widest ${
                  i === 0 ? "text-accent" : "text-bone-50/40"
                }`}
              >
                {i + 1}
              </span>
              <span
                className="min-w-0 flex-1 truncate text-[0.77rem]"
                data-tooltip={e.name}
              >
                {e.name}
                {isMe && (
                  <span className="ml-1 text-[9.2px] uppercase text-accent">
                    you
                  </span>
                )}
              </span>
              {/* Live combo badge — makes the sidebar feel like a race
                  even when scores are close. Only shown for non-finished
                  players (finished rows show the ✓ mark instead). */}
              {!e.finished && e.combo > 0 && (
                <span
                  className={`shrink-0 px-1 text-[9.2px] tabular-nums tracking-widest ${
                    e.combo >= 50
                      ? "text-accent"
                      : e.combo >= 10
                        ? "text-bone-50/70"
                        : "text-bone-50/40"
                  }`}
                  data-tooltip={`Combo ×${e.combo}`}
                >
                  ×{e.combo}
                </span>
              )}
              <span className="shrink-0 text-right text-[11.2px] tabular-nums text-bone-50">
                {e.score.toLocaleString()}
              </span>
              {e.finished && (
                <span
                  className="shrink-0 text-[9.2px] uppercase tracking-widest text-accent"
                  data-tooltip="Finished"
                >
                  ✓
                </span>
              )}
              {!e.online && (
                <span
                  className="shrink-0 text-[9.2px] uppercase tracking-widest text-bone-50/30"
                  data-tooltip="Disconnected"
                >
                  ⌀
                </span>
              )}
            </li>
          );
        })}
      </ol>
      </aside>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* HUD bits                                                                 */
/* ------------------------------------------------------------------------ */

/** mm:ss formatter for the song-progress label. Defined locally so
 * the HUD doesn't depend on a shared util — also matches the helper
 * in single-player Game.tsx so output formatting stays in lockstep. */
function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function PerformancePanel({
  stats,
  chartMode,
  songDuration,
}: {
  stats: PlayerStats;
  chartMode: ChartMode;
  /** Track duration in seconds, or null until the chart is loaded. */
  songDuration: number | null;
}) {
  const accuracy = computeAccuracy(stats);
  const tierStars = modeStars(chartMode);
  return (
    // Performance card — score + combo + rock meter + hits stats in one
    // cohesive "how are you doing" block. Mirrors the single-player HUD
    // exactly so both modes share visual vocabulary; the only difference
    // here is there's no pause button (multi can't pause without
    // freezing the rest of the room). The rock meter bar is bumped up
    // (`h-3.5 sm:h-[1.05rem]`) so it reads as the headline status
    // indicator of the card instead of a thin afterthought.
    <div className="brut-card-accent flex w-full flex-col gap-2 px-2.5 py-2 sm:gap-2.5 sm:px-3 sm:py-3 xl:gap-3 xl:px-4">
      <div className="flex items-stretch gap-2 sm:gap-3 xl:gap-4">
        <div className="min-w-[89px] sm:min-w-[140px] xl:min-w-[153px]">
          <p className="font-mono text-[9.2px] uppercase tracking-widest text-bone-50/60 sm:text-[10.2px]">
            Score
          </p>
          <p className="font-display text-[1.27rem] font-bold leading-none sm:text-[1.91rem]">
            {stats.score.toLocaleString()}
          </p>
          <p className="mt-1 font-mono text-[9.2px] text-bone-50/60 sm:text-[10.2px]">
            {accuracy.toFixed(1)}% · {stats.notesPlayed}/{stats.totalNotes}
          </p>
        </div>
        <div className="w-px shrink-0 bg-bone-50/20" aria-hidden />
        <div className="flex min-w-[57px] flex-col items-center justify-center sm:min-w-[74px] xl:min-w-[81px]">
          <p className="font-mono text-[9.2px] uppercase tracking-widest text-bone-50/60 sm:text-[10.2px]">
            Combo
          </p>
          <p
            className={`font-display text-[1.53rem] font-bold leading-none tabular-nums sm:text-[2.29rem] ${
              stats.combo > 0 ? "text-accent" : "text-bone-50/40"
            }`}
          >
            {stats.combo}
          </p>
          <p className="mt-1 font-mono text-[10.2px] font-bold text-accent sm:text-[0.76rem]">
            ×{stats.multiplier}
          </p>
        </div>
      </div>
      {/* Faint rule separates score/combo numbers from the rock
          meter group below — without it the two halves of the card
          look like one big block of mixed types. */}
      <div className="h-px w-full bg-bone-50/15" aria-hidden />
      {/* Rock meter label on the left, difficulty tag on the right
          — the tag tells the player which tier they're actually
          playing right now and lives next to the rock meter (the
          live "performance" block) instead of on the now-playing
          strip across the screen, since difficulty is part of the
          gameplay context, not the song metadata. Same accent
          name-only chip as the lobby picker; chart density (notes
          / nps) shows on hover. */}
      <div className="flex items-center justify-between gap-2">
        <p className="font-mono text-[9.2px] uppercase tracking-widest text-bone-50/60 sm:text-[10.2px]">
          Rock meter
        </p>
        <span
          className="inline-flex shrink-0 items-center border border-accent/60 px-1.5 py-0.5 font-mono text-[8.2px] uppercase tracking-widest text-accent sm:text-[9.2px]"
          data-tooltip={
            stats.totalNotes > 0 && songDuration && songDuration > 0
              ? `${stats.totalNotes.toLocaleString()} notes · ${(stats.totalNotes / songDuration).toFixed(1)} nps`
              : `Difficulty: ${displayMode(chartMode)} (${tierStars} / 5 intensity)`
          }
        >
          {displayMode(chartMode)}
        </span>
      </div>
      <div className="relative h-3.5 w-full border-2 border-bone-50/40 sm:h-[1.05rem]">
        <div
          className="absolute inset-y-0 left-0 transition-[width] duration-200"
          style={{
            width: `${stats.health * 100}%`,
            background:
              stats.health > 0.6
                ? "#3dff8a"
                : stats.health > 0.3
                ? "#ffd23f"
                : "#ff3b6b",
          }}
        />
      </div>
      <p className="font-mono text-[9.2px] text-bone-50/60 sm:text-[10.2px]">
        P{stats.hits.perfect} · G{stats.hits.great} · g{stats.hits.good} · M
        {stats.hits.miss}
      </p>
    </div>
  );
}

/**
 * Multiplayer settings card — now-playing strip + per-player audio /
 * perf knobs (Metronome, Input feedback, FPS lock, Volume), all styled
 * as consistent border-tiled rows. The rock meter itself moved up into
 * `PerformancePanel` (where it conceptually belongs alongside score and
 * combo); this card now owns the "settings" half of the HUD exclusively.
 * `w-full` so the card stretches to match the performance panel above
 * (the parent column is `w-fit`).
 */
function HealthPanel({
  stats,
  volume,
  onVolume,
  metronome,
  onToggleMetronome,
  sfx,
  onToggleSfx,
  fps,
  fpsLock,
  onCycleFpsLock,
  songTitle,
  songArtist,
  songDuration,
  songProgress,
}: {
  stats: PlayerStats;
  volume: number;
  onVolume: (v: number) => void;
  metronome: boolean;
  onToggleMetronome: () => void;
  /** Per-input feedback SFX toggle (hit / miss / release / milestone). */
  sfx: boolean;
  onToggleSfx: () => void;
  fps: number;
  fpsLock: FpsLock;
  onCycleFpsLock: () => void;
  songTitle: string | null;
  songArtist: string | null;
  /** Track duration in seconds, or null until the chart is loaded. */
  songDuration: number | null;
  /** Fractional song progress 0..1, throttled in the rAF loop. */
  songProgress: number;
}) {
  return (
    <div className="brut-card flex w-full flex-col gap-1.5 px-2.5 py-2 sm:gap-2 sm:px-3 sm:py-3">
      {/* "Now playing" strip — see Game.tsx HUD for the rationale (single
          on-screen reminder of what song is rolling once the lobby card is
          gone). In multi we prefer the locally-loaded chart's metadata
          when available, falling back to the room snapshot's `selectedSong`
          so the strip is populated even before the audio buffer is ready.
          The difficulty tag was lifted out of this block and now lives
          next to the rock meter in `PerformancePanel`, since difficulty
          is gameplay state rather than song metadata. */}
      {songTitle && (
        <div className="flex min-w-0 flex-col border-b-2 border-bone-50/15 pb-1.5">
          <p className="truncate font-mono text-[8.2px] uppercase tracking-widest text-bone-50/45 sm:text-[9.2px]">
            ♪ Now playing
          </p>
          <p
            className="truncate font-mono text-[10.2px] font-bold text-bone-50/90 sm:text-[11.2px]"
            data-tooltip={`${songTitle}${songArtist ? ` — ${songArtist}` : ""}`}
          >
            {songTitle}
          </p>
          {songArtist && (
            <p
              className="truncate font-mono text-[9.2px] text-bone-50/50 sm:text-[10.2px]"
              data-tooltip={songArtist}
            >
              {songArtist}
            </p>
          )}
          {/* Live song progress strip — slim, accent-fill, mm:ss
              elapsed/total on the right. Mirrors the single-player
              HUD so multiplayer feels consistent. The fill source
              `songProgress` is throttled to ~10Hz from the rAF loop,
              and the audio clock (server-synced via `startsAt`) is
              the underlying truth, so all clients see the bar
              advance in lockstep within audio-sync tolerance. */}
          {songDuration && songDuration > 0 && (
            <div className="mt-1.5 flex items-center gap-1.5">
              <div
                className="relative h-[3px] flex-1 border border-bone-50/25 bg-bone-50/5"
                role="progressbar"
                aria-label="Song progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(songProgress * 100)}
              >
                <div
                  className="absolute inset-y-0 left-0 bg-accent transition-[width] duration-200 ease-linear"
                  style={{ width: `${Math.min(100, Math.max(0, songProgress * 100))}%` }}
                />
              </div>
              <span className="shrink-0 font-mono text-[8.2px] tabular-nums text-bone-50/45 sm:text-[9.2px]">
                {formatDuration(songProgress * songDuration)}
                <span className="text-bone-50/30">
                  {" / "}
                  {formatDuration(songDuration)}
                </span>
              </span>
            </div>
          )}
        </div>
      )}
      {/* Metronome tile — `<label>` so clicking anywhere on the
          tile (caption included) toggles the checkbox. Same
          aesthetic as the StartCard's pre-game toggle tiles, just
          scaled down for HUD density. */}
      <label
        className="pointer-events-auto flex cursor-pointer items-center justify-between gap-2 border border-bone-50/30 bg-ink-900/40 px-2 py-1.5"
        data-tooltip="Toggle metronome (M)"
      >
        <span className="font-mono text-[9.2px] uppercase tracking-widest text-bone-50/70 sm:text-[10.2px]">
          Metronome
        </span>
        <input
          type="checkbox"
          checked={metronome}
          onChange={onToggleMetronome}
          className="h-[14px] w-[14px] cursor-pointer accent-accent"
          aria-label="Toggle metronome"
          aria-keyshortcuts="M"
        />
      </label>
      <label
        className="pointer-events-auto flex cursor-pointer items-center justify-between gap-2 border border-bone-50/30 bg-ink-900/40 px-2 py-1.5"
        data-tooltip="Toggle input feedback (N)"
      >
        <span className="font-mono text-[9.2px] uppercase tracking-widest text-bone-50/70 sm:text-[10.2px]">
          Input feedback
        </span>
        <input
          type="checkbox"
          checked={sfx}
          onChange={onToggleSfx}
          className="h-[14px] w-[14px] cursor-pointer accent-accent"
          aria-label="Toggle input sound effects"
          aria-keyshortcuts="N"
          aria-pressed={sfx}
        />
      </label>
      {/* FPS lock tile — same two-column layout as the single-
          player HUD: left column stacks "FPS LOCK" caption over
          the live `### fps` readout, right column shows the cap
          (OFF / 30 / 60) as plain accent / dim text. The audio
          engine + server-driven start timestamps are unaffected
          by the cap so room sync stays exact regardless of which
          lock the player picks. */}
      <button
        type="button"
        onClick={onCycleFpsLock}
        className="pointer-events-auto hidden cursor-pointer items-center justify-between gap-2 border border-bone-50/30 bg-ink-900/40 px-2 py-1.5 text-left sm:flex"
        data-tooltip={
          fpsLock == null
            ? "FPS lock off — click to cap at 30 FPS"
            : `Render frame-rate capped at ${fpsLock} FPS — click to ${
                fpsLock === 30 ? "cap at 60" : "uncap"
              }`
        }
        aria-label="Cycle render FPS lock"
      >
        <span className="flex flex-col">
          <span className="font-mono text-[9.2px] uppercase tracking-widest text-bone-50/70 sm:text-[10.2px]">
            FPS lock
          </span>
          <span className="font-mono text-[9.2px] tabular-nums tracking-widest text-bone-50/40">
            {fps}fps
          </span>
        </span>
        <span
          aria-hidden
          className={`font-mono text-[9.2px] uppercase tracking-widest tabular-nums transition-colors ${
            fpsLock == null ? "text-bone-50/60" : "text-accent"
          }`}
        >
          {fpsLock == null ? "OFF" : fpsLock}
        </span>
      </button>
      <div className="flex items-center gap-2 border border-bone-50/30 bg-ink-900/40 px-2 py-1.5">
        <span className="font-mono text-[9.2px] uppercase tracking-widest text-bone-50/60 sm:text-[10.2px]">
          vol
        </span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={(e) => onVolume(parseFloat(e.target.value))}
          // See Game.tsx HUD for why min-w-0 is required here — the
          // UA intrinsic min-width on <input type="range"> would
          // otherwise overflow the tile on narrow viewports.
          className="pointer-events-auto h-1 min-w-0 flex-1 cursor-pointer accent-accent"
          aria-label="Music volume"
        />
        <span className="hidden sm:inline font-mono text-[9.2px] tabular-nums text-bone-50/40 w-7 text-right">
          {Math.round(volume * 100)}
        </span>
      </div>
    </div>
  );
}

/**
 * Same scrollable-overlay pattern as the single-player Game's Overlay —
 * see that component for the rationale. Multiplayer hits the same bug
 * on tall LoadingScreen content + short viewports, so the same fix.
 */
function Overlay({
  children,
  translucent,
}: {
  children: React.ReactNode;
  translucent?: boolean;
}) {
  return (
    <div
      className={`absolute inset-0 z-20 overflow-y-auto overscroll-contain ${
        translucent ? "bg-ink-900/40 backdrop-blur-sm" : "bg-ink-900/80 backdrop-blur"
      }`}
    >
      <div className="flex min-h-full items-center justify-center px-4 py-6 sm:px-6 sm:py-8">
        {children}
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <span
      role="status"
      aria-label="Loading"
      className="inline-block h-[1.05rem] w-[1.05rem] animate-spin rounded-full border-2 border-bone-50/20 border-t-accent"
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
