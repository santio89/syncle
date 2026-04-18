"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AudioEngine } from "@/lib/game/audio";
import { GameState, isHold } from "@/lib/game/engine";
import {
  ChartMode,
  displayMode,
  loadSong,
  MODE_ORDER,
  ModeAvailability,
  modeStars,
  PLACEHOLDER_META,
  prefetchAudio,
} from "@/lib/game/chart";
import {
  createRenderState,
  crossedComboMilestone,
  DEFAULT_RENDER_OPTIONS,
  drawFrame,
  RenderState,
} from "@/lib/game/renderer";
import { Note, PlayerStats, SongMeta, TOTAL_LANES } from "@/lib/game/types";
import {
  loadBest,
  saveBestIfHigher,
  bestKey,
  RunBest,
} from "@/lib/game/best";
import { recordRun } from "@/lib/game/stats";
import {
  loadVolume,
  saveVolume,
  loadFpsLock,
  saveFpsLock,
  nextFpsLock,
  type FpsLock,
} from "@/lib/game/settings";
import { useTheme } from "@/components/ThemeProvider";
import { ArrowIcon, type ArrowDirection } from "@/components/icons/ArrowIcon";
import { StatusBadge } from "@/components/StatusBadge";

type Phase =
  | "idle"
  | "loading"
  | "ready"
  | "countdown"
  | "playing"
  | "paused"
  | "results";

const COUNTDOWN_SECONDS = 3;

// Extra silent runway between "1" disappearing and the song actually
// starting. The countdown overlay covers the highway visually, so without
// this the player goes straight from "covered screen" → "first note hits"
// in zero milliseconds for any chart whose first note sits on songTime≈0.
// Two seconds is enough for the highway to spawn the first wave of notes
// (leadTime is 1.2s) AND give the player half a second of empty grid to
// settle before notes start sliding in.
const LEAD_IN_SECONDS = 2;
const TOTAL_START_DELAY = COUNTDOWN_SECONDS + LEAD_IN_SECONDS;

// Each lane accepts EITHER its letter key OR the matching arrow key.
// 4 lanes only — osu!mania 4K layout.
const KEY_TO_LANE: Record<string, number> = {
  KeyD: 0, ArrowLeft: 0,
  KeyF: 1, ArrowDown: 1,
  KeyJ: 2, ArrowUp: 2,
  KeyK: 3, ArrowRight: 3,
};

export default function Game() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioRef = useRef<AudioEngine | null>(null);
  const stateRef = useRef<GameState | null>(null);
  const renderStateRef = useRef<RenderState>(createRenderState());
  /**
   * Combo from the previous frame — used to detect when we cross one of the
   * milestone thresholds (25/50/100/...). When that happens we both flash the
   * canvas (vignette tint via renderer) and play a brief upward arpeggio.
   * Tracked outside of React state so the RAF loop is allocation-free.
   */
  const prevComboRef = useRef<number>(0);
  const heldRef = useRef<boolean[]>(new Array(TOTAL_LANES).fill(false));
  const rafRef = useRef<number | null>(null);
  /** Shared empty state used during idle/loading frames (drawing a blank highway).
   *  Avoids `new GameState([])` per frame which is a hidden alloc + GC churn. */
  const emptyStateRef = useRef<GameState>(new GameState([]));
  /** Mutable RenderOptions reused every frame to avoid allocating in the loop. */
  const renderOptsRef = useRef({ ...DEFAULT_RENDER_OPTIONS });
  /** Last-loaded chart result, kept in a ref so the audio-prep effect can
   *  reach the raw audio bytes (for remote-delivery songs) without depending
   *  on a state field that changes identity on every difficulty toggle. */
  const loadedRef = useRef<{
    meta: SongMeta;
    notes: Note[];
    audioBytes?: ArrayBuffer;
    audioKey?: string;
    delivery: "local" | "remote";
  } | null>(null);
  /** Highest beat index for which a metronome click has already been scheduled. */
  const lastScheduledBeatRef = useRef<number>(-1);
  const songRef = useRef<{ meta: SongMeta; notes: Note[] }>({
    meta: PLACEHOLDER_META,
    notes: [],
  });

  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<number>(COUNTDOWN_SECONDS);
  const [stats, setStats] = useState<PlayerStats | null>(null);
  const [metronome, setMetronome] = useState<boolean>(true);
  const [chartLength, setChartLength] = useState<number>(0);
  const [songSource, setSongSource] = useState<"osu" | "fallback" | null>(null);
  const [chartMode, setChartMode] = useState<ChartMode>("easy");
  const [rawNoteCount, setRawNoteCount] = useState<number>(0);
  // Per-mode availability — drives the disabled state of the difficulty
  // buttons. Defaults to "all available" while loading so the picker doesn't
  // flash into a disabled state on first paint.
  const [modeAvailability, setModeAvailability] = useState<ModeAvailability>({
    // Initial placeholder: EVERY tier disabled until the real chart
    // resolves and quantization completes for all 5 buckets. Showing
    // hard (or any other tier) as enabled too early would let the
    // player click a button whose density we haven't actually computed
    // yet, then re-render with a different availability map a frame
    // later — visually jumpy and racy. All-disabled-until-ready keeps
    // the picker honest on first paint.
    noteCounts: { easy: 0, normal: 0, hard: 0, insane: 0, expert: 0 },
    available: {
      easy: false,
      normal: false,
      hard: false,
      insane: false,
      expert: false,
    },
    npsByMode: { easy: 0, normal: 0, hard: 0, insane: 0, expert: 0 },
  });
  /** Real meta once the chart loads — null until then so we can show a spinner. */
  const [displayMeta, setDisplayMeta] = useState<SongMeta | null>(null);
  /** Error string if the chart preview fetch failed. */
  const [previewError, setPreviewError] = useState<string | null>(null);
  /** Live progress message during preview/load (e.g. "Trying catboy.best…"). */
  const [progressMsg, setProgressMsg] = useState<string | null>(null);
  /** Mirror name when the song was fetched remotely (e.g. "catboy.best"). */
  const [mirror, setMirror] = useState<string | null>(null);
  /** Beatmapset id when delivered remotely. */
  const [beatmapsetId, setBeatmapsetId] = useState<number | null>(null);
  const [best, setBest] = useState<RunBest | null>(null);
  /** True if the just-finished run set a new lifetime best for this track. */
  const [newBest, setNewBest] = useState<boolean>(false);
  /** Master song volume 0..1, persisted across sessions. */
  const [volume, setVolume] = useState<number>(0.85);
  /** Rolling average frame rate, sampled every ~250ms for HUD readout. */
  const [fps, setFps] = useState<number>(0);
  /** Optional render frame-rate cap (off / 30 / 60). Persisted across
   *  sessions. The rAF loop reads `fpsLockRef.current` so toggling the
   *  lock takes effect on the next frame without a remount.
   *  Hydrated from localStorage in the same effect that loads `volume`. */
  const [fpsLock, setFpsLock] = useState<FpsLock>(null);
  const fpsLockRef = useRef<FpsLock>(null);
  useEffect(() => {
    fpsLockRef.current = fpsLock;
  }, [fpsLock]);
  /** True if the user is on a touch-only device (no physical keyboard).
   *  Drives the on-screen <TouchLanes> overlay and swaps the "press D F J K"
   *  hints in the StartCard for tap-friendly copy. */
  const [touchOnly, setTouchOnly] = useState<boolean>(false);

  // ---- Live theme → canvas wiring ---------------------------------------
  // The renderer reads `theme` off renderOptsRef every frame to look up its
  // palette. We mirror the React-side theme into that ref AND invalidate the
  // gradient cache (highway / vignette gradients are baked per palette), so
  // the next RAF tick redraws with the new colors. Because the RAF loop runs
  // continuously, the swap is visually instant (limited only by the same
  // cubic-bezier the rest of the page uses for theme transitions — the
  // canvas itself just hard-cuts to the new palette in one frame, which
  // reads as in-sync with the surrounding 220ms CSS crossfade).
  const { theme } = useTheme();
  useEffect(() => {
    renderOptsRef.current.theme = theme;
    renderStateRef.current.cache = undefined;
  }, [theme]);

  // Force-load the JetBrains Mono ExtraBold weight used by the lane-gate
  // letters drawn on the canvas. next/font only downloads weights that are
  // actually used on the page, and canvas font requests don't count as
  // usage — so without this the browser silently falls back to the next
  // available weight (700) and our "800" letters render thinner than
  // intended for the first few seconds. document.fonts.load triggers a
  // real download and resolves once the file is in memory.
  useEffect(() => {
    if (typeof document === "undefined" || !document.fonts) return;
    document.fonts
      .load("800 26px 'JetBrains Mono'")
      .catch(() => {
        // Font load can reject on networks with strict ad-blockers blocking
        // Google Fonts; we're fine to silently fall back to system mono.
      });
  }, []);

  // Pre-load chart meta on mount + whenever the difficulty changes.
  //
  // For local songs this is cheap: a small chart fetch + parse, then we kick
  // off an audio prefetch so PLAY click is instant.
  //
  // For remote pool songs this is the heavy work: download a 3–8 MB .osz
  // from a public mirror, unzip it in the browser, extract the 4K mania
  // chart + audio bytes. We expose live progress via setProgressMsg so the
  // start card can show "Trying catboy.best…" rather than a dead spinner.
  useEffect(() => {
    let cancelled = false;
    setDisplayMeta(null);
    setPreviewError(null);
    setProgressMsg(null);
    setMirror(null);
    setBeatmapsetId(null);
    loadSong(chartMode, {
      onProgress: (msg) => {
        if (!cancelled) setProgressMsg(msg);
      },
    })
      .then((loaded) => {
        if (cancelled) return;
        loadedRef.current = {
          meta: loaded.meta,
          notes: loaded.notes,
          audioBytes: loaded.audioBytes,
          audioKey: loaded.audioKey,
          delivery: loaded.delivery,
        };
        setDisplayMeta(loaded.meta);
        setSongSource(loaded.source);
        setChartLength(loaded.notes.length);
        setRawNoteCount(loaded.rawNoteCount);
        setModeAvailability(loaded.modes);
        // If the song doesn't actually have a distinct chart for the
        // current mode, hop to the next available one toward "hard". This
        // keeps the player on a chart that reflects what they picked
        // instead of silently rendering the same notes as another mode.
        const fallback = pickAvailableMode(chartMode, loaded.modes);
        if (fallback !== chartMode) {
          setChartMode(fallback);
          // The setState above will retrigger this effect with the new
          // mode; we'll fill in the rest of the UI on that pass.
          return;
        }
        setBest(loadBest(bestKey(loaded.meta.id, chartMode)));
        setProgressMsg(null);
        if (loaded.delivery === "remote") {
          setMirror(loaded.mirror ?? null);
          setBeatmapsetId(loaded.beatmapsetId ?? null);
        } else {
          // Warm the HTTP cache for the audio bytes — safe to do without a
          // user gesture since we're not creating an AudioContext yet.
          prefetchAudio(loaded.meta.audioUrl);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setPreviewError(err?.message ?? "Could not load a chart");
        setProgressMsg(null);
      });
    return () => {
      cancelled = true;
    };
  }, [chartMode]);

  // Once we have a real meta AND the user has interacted with the page at
  // least once (any click / keydown / pointermove), spin up the AudioContext
  // and decode the song in the background. Decoding requires a context but
  // not necessarily a *running* one — a suspended context is enough — so by
  // the time the user clicks PLAY the AudioBuffer is ready and start() is
  // basically a no-op.
  useEffect(() => {
    if (!displayMeta) return;
    let cancelled = false;
    let prepped = false;
    const prep = () => {
      if (prepped || cancelled) return;
      prepped = true;
      window.removeEventListener("pointerdown", prep);
      window.removeEventListener("keydown", prep);
      window.removeEventListener("pointermove", prep);
      try {
        if (!audioRef.current) audioRef.current = new AudioEngine();
        audioRef.current.ensureContext();
        audioRef.current.setMetronome(metronome);
        audioRef.current.setVolume(volume);
        // Fire and forget — by the time PLAY is clicked, this is usually done.
        const loaded = loadedRef.current;
        if (loaded?.delivery === "remote" && loaded.audioBytes && loaded.audioKey) {
          // Bytes were already extracted by oszFetcher; just decode them.
          // We pass a SLICE so the original buffer survives if start() needs
          // to retry (decodeAudioData detaches the input).
          void audioRef.current
            .loadFromBytes(loaded.audioBytes.slice(0), loaded.audioKey)
            .catch(() => {});
        } else if (displayMeta.audioUrl) {
          void audioRef.current.load(displayMeta.audioUrl).catch(() => {});
        }
      } catch {
        // Some browsers refuse to create an AudioContext outside a gesture;
        // fall back to creating it lazily inside start() like before.
      }
    };
    window.addEventListener("pointerdown", prep, { once: false });
    window.addEventListener("keydown", prep, { once: false });
    window.addEventListener("pointermove", prep, { once: false });
    return () => {
      cancelled = true;
      window.removeEventListener("pointerdown", prep);
      window.removeEventListener("keydown", prep);
      window.removeEventListener("pointermove", prep);
    };
  }, [displayMeta, metronome, volume]);

  useEffect(() => {
    audioRef.current?.setMetronome(metronome);
  }, [metronome]);

  useEffect(() => {
    audioRef.current?.setVolume(volume);
    saveVolume(volume);
  }, [volume]);

  // Persist the FPS lock the moment it changes (the rAF loop already
  // picks it up via fpsLockRef; this just keeps the choice across
  // refreshes / new sessions).
  useEffect(() => {
    saveFpsLock(fpsLock);
  }, [fpsLock]);

  // Hydrate persisted volume + detect touch-only devices on mount.
  useEffect(() => {
    setVolume(loadVolume());
    setFpsLock(loadFpsLock());
    if (typeof window !== "undefined" && window.matchMedia) {
      // pointer:coarse + no fine pointer ⇒ phone/tablet without a real keyboard.
      const coarse = window.matchMedia("(pointer: coarse)").matches;
      const noFine = !window.matchMedia("(any-pointer: fine)").matches;
      setTouchOnly(coarse && noFine);
    }
  }, []);

  // ---- Crisp canvas: handle DPR + resize --------------------------------
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
      // Force the renderer to rebuild its size-dependent gradient cache.
      renderStateRef.current.cache = undefined;
      // Pre-build the gradient cache + JIT-compile the draw path right now
      // (still on the loading screen, before any notes scroll), so the very
      // first in-game frame doesn't spend 20–40ms building gradients and
      // hot-compiling drawHighway / drawTapNote.
      //
      // Use the LIVE renderOptsRef (which already has the active theme set
      // by the useTheme effect) instead of DEFAULT_RENDER_OPTIONS — otherwise
      // a user in light mode would have the dark-palette gradients baked
      // into the cache for the first frame, then swapped on the next
      // resize/theme effect. Reading the ref keeps the pre-warm honest.
      if (ctx) {
        try {
          drawFrame(
            ctx,
            new GameState([]),
            -COUNTDOWN_SECONDS,
            0,
            renderOptsRef.current,
            renderStateRef.current,
          );
        } catch {
          // Pre-warm is best-effort. If it throws (e.g. ctx in a weird
          // state mid-resize), we'll get there on the first real frame.
        }
      }
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

  // ---- Start / load -----------------------------------------------------
  // Most of the heavy lifting (fetch + decode the audio, parse the chart,
  // build the gradient cache) has already happened by the time we get here:
  //   - chart: loaded by the preview useEffect, returned from cache
  //   - audio: fetched + decoded by the prep effect on first user gesture
  //   - canvas/gradients: pre-built by the resize effect's warmup draw
  // So this is now ~mostly synchronous: build the GameState, await fonts
  // (cheap — already loading from layout), schedule audio, kick countdown.
  const start = useCallback(async () => {
    setError(null);
    setNewBest(false);
    setPhase("loading");
    try {
      // Re-use the engine the prep effect built; otherwise create one now.
      let audio = audioRef.current;
      if (!audio) {
        audio = new AudioEngine();
        audioRef.current = audio;
      }
      audio.ensureContext();
      audio.setMetronome(metronome);
      audio.setVolume(volume);

      const loaded = await loadSong(chartMode); // cached → instant
      songRef.current = { meta: loaded.meta, notes: loaded.notes };
      setSongSource(loaded.source);
      setChartLength(loaded.notes.length);
      setRawNoteCount(loaded.rawNoteCount);

      // Idempotent: skips fetch+decode if the prep effect already did it.
      if (loaded.delivery === "remote" && loaded.audioBytes && loaded.audioKey) {
        await audio.loadFromBytes(loaded.audioBytes.slice(0), loaded.audioKey);
      } else {
        await audio.load(loaded.meta.audioUrl);
      }

      // Make sure the display font has loaded before we start drawing the
      // judgment popups + countdown — otherwise the first popup triggers a
      // sync font swap and skips a frame.
      if (typeof document !== "undefined" && (document as any).fonts?.ready) {
        try {
          await (document as any).fonts.ready;
        } catch {
          /* noop */
        }
      }

      const state = new GameState(loaded.notes);
      stateRef.current = state;
      setStats({ ...state.stats });
      lastScheduledBeatRef.current = -1;

      setPhase("countdown");
      setCountdown(COUNTDOWN_SECONDS);

      // Schedule the song to begin AFTER both the countdown and the silent
      // lead-in. songTime() goes negative during this whole window, so notes
      // (which all live at positive times) stay above the judgment line —
      // the highway just slides empty until the first beat actually arrives.
      audio.start(TOTAL_START_DELAY, volume);

      const startedAt = performance.now();
      const tickCountdown = () => {
        const elapsed = (performance.now() - startedAt) / 1000;
        const remaining = COUNTDOWN_SECONDS - elapsed;
        if (remaining <= 0) {
          setPhase("playing");
          return;
        }
        setCountdown(Math.ceil(remaining));
        requestAnimationFrame(tickCountdown);
      };
      requestAnimationFrame(tickCountdown);
    } catch (e: any) {
      console.error(e);
      setError(e?.message ?? "Failed to start");
      setPhase("idle");
    }
  }, [metronome, volume, chartMode]);

  // ---- Pause / resume --------------------------------------------------
  const pause = useCallback(async () => {
    if (phase !== "playing") return;
    await audioRef.current?.pause();
    // Drop any keys held when we paused so we don't auto-fire on resume.
    heldRef.current = new Array(TOTAL_LANES).fill(false);
    setPhase("paused");
  }, [phase]);

  const resume = useCallback(async () => {
    if (phase !== "paused") return;
    await audioRef.current?.resume();
    setPhase("playing");
  }, [phase]);

  const giveUp = useCallback(() => {
    // Stop the song but keep the AudioEngine + decoded buffer alive so the
    // next start() doesn't re-fetch / re-decode the audio.
    audioRef.current?.stop();
    stateRef.current = null;
    resetRenderState(renderStateRef.current);
    heldRef.current.fill(false);
    prevComboRef.current = 0;
    lastScheduledBeatRef.current = -1;
    songRef.current = { meta: PLACEHOLDER_META, notes: [] };
    setStats(null);
    setNewBest(false);
    setPhase("idle");
  }, []);

  // Auto-pause when the tab is hidden — otherwise the audio clock keeps
  // running while requestAnimationFrame is throttled to 1Hz, and the
  // game catches up with a giant burst of misses on tab refocus.
  useEffect(() => {
    if (phase !== "playing") return;
    const onVis = () => {
      if (document.hidden) void pause();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [phase, pause]);

  // ---- Input handling ---------------------------------------------------
  // Both the keyboard listener and the on-screen touch lane buttons go
  // through the same pressLane / releaseLane helpers so the engine sees a
  // single, consistent event stream regardless of input source. The helpers
  // are stable (useCallback) and read `phase` via a ref so we don't have
  // to re-bind every state change — that matters for touch, where the
  // <TouchLanes> overlay re-renders along with the rest of the canvas
  // container and we don't want to drop pointer captures.
  const phaseRef = useRef<Phase>(phase);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const pressLane = useCallback((lane: number) => {
    const p = phaseRef.current;
    if (p === "paused") return;
    // Always remember the lane is held — the renderer reads heldRef to
    // light the gate even during countdown, so the pre-roll feels alive.
    heldRef.current[lane] = true;
    if (p !== "playing") return;

    const audio = audioRef.current;
    const state = stateRef.current;
    if (!audio || !state) return;

    const songTime = audio.songTime();
    const evt = state.hit(lane, songTime);
    if (evt) {
      renderStateRef.current.laneFlash[lane] = 1;
      renderStateRef.current.pendingHits.push({
        lane,
        judgment: evt.judgment,
      });
      audio.playHit(lane, evt.judgment);
    } else {
      renderStateRef.current.laneFlash[lane] = 0.45;
      audio.playMiss(true);
    }
  }, []);

  const releaseLane = useCallback((lane: number) => {
    const p = phaseRef.current;
    if (p === "paused") return;
    heldRef.current[lane] = false;
    if (p !== "playing") return;

    const audio = audioRef.current;
    const state = stateRef.current;
    if (!audio || !state) return;

    // If a hold was active in this lane, judge the tail on release.
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
    if (phase !== "playing" && phase !== "countdown" && phase !== "paused")
      return;

    const onKeyDown = (e: KeyboardEvent) => {
      // Don't hijack key events while a text input or textarea has focus —
      // future-proofs against in-game chat / pause-menu fields without
      // accidentally muting D/F/J/K when the player just clicked a slider.
      if (isEditableTarget(e.target)) return;
      if (e.code === "Escape") {
        e.preventDefault();
        if (phase === "playing") void pause();
        else if (phase === "paused") void resume();
        return;
      }
      if (phase === "paused") return;
      if (e.code === "KeyM") {
        setMetronome((m) => !m);
        e.preventDefault();
        return;
      }
      if (e.repeat) return;
      const lane = KEY_TO_LANE[e.code];
      if (lane === undefined) return;
      e.preventDefault();
      pressLane(lane);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      if (phase === "paused") return;
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
  }, [phase, pause, resume, pressLane, releaseLane]);

  // ---- Render loop ------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let last = performance.now();
    let lastHudUpdate = 0;
    let lastMissCount = stateRef.current?.stats.hits.miss ?? 0;
    // Rolling FPS sample window — frames per ~500ms.
    let fpsAccumFrames = 0;
    let fpsAccumStart = last;

    const loop = () => {
      const now = performance.now();
      // Optional render frame-rate cap. We still wake on every vblank
      // (rAF), but skip the draw + game-tick work until the per-frame
      // budget has elapsed. Tolerance of 1.5ms absorbs vblank jitter so
      // a 60-cap on a 200Hz monitor settles at ~60fps instead of ~50.
      // The audio engine runs off its own AudioContext clock so capping
      // render frames does NOT desync hits or metronome timing.
      const lockedFps = fpsLockRef.current;
      if (lockedFps != null) {
        const budgetMs = 1000 / lockedFps - 1.5;
        if (now - last < budgetMs) {
          rafRef.current = requestAnimationFrame(loop);
          return;
        }
      }
      // Clamp dt to 100ms so a tab-switch / pause doesn't yank particles
      // hundreds of pixels in a single frame on the first frame back.
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;

      fpsAccumFrames++;
      if (now - fpsAccumStart >= 500) {
        const measured = (fpsAccumFrames * 1000) / (now - fpsAccumStart);
        setFps(Math.round(measured));
        fpsAccumFrames = 0;
        fpsAccumStart = now;
      }

      const audio = audioRef.current;
      const state = stateRef.current;
      const songMeta = songRef.current.meta;
      const beatLen = 60 / songMeta.bpm;
      const songTime = audio ? audio.songTime() : -COUNTDOWN_SECONDS;

      if (state && phase === "playing") {
        state.expireMisses(songTime);

        const misses = state.stats.hits.miss;
        if (misses > lastMissCount) {
          audio?.playMiss(false);
          lastMissCount = misses;
        }

        const lastNote = state.notes[state.notes.length - 1];
        const lastEnd = lastNote
          ? (isHold(lastNote) ? (lastNote.endT as number) : lastNote.t)
          : 0;
        if (
          lastNote &&
          songTime > lastEnd + 1.5 &&
          state.notes.every((n) => n.judged && (!isHold(n) || n.tailJudged))
        ) {
          finishRun(state);
        } else if (
          audio &&
          !audio.isPlaying &&
          songTime > songMeta.duration - 0.5
        ) {
          finishRun(state);
        }
      }

      // Schedule metronome clicks ahead of the audio clock.
      if (audio && (phase === "playing" || phase === "countdown")) {
        const lookaheadSec = 0.6;
        const horizon = songTime + lookaheadSec;
        const firstBeatIdx = Math.max(
          0,
          Math.ceil((songTime - songMeta.offset) / beatLen),
        );
        const lastBeatIdx = Math.floor((horizon - songMeta.offset) / beatLen);
        for (let bi = firstBeatIdx; bi <= lastBeatIdx; bi++) {
          if (bi <= lastScheduledBeatRef.current) continue;
          const beatSongTime = songMeta.offset + bi * beatLen;
          if (beatSongTime < 0) {
            lastScheduledBeatRef.current = bi;
            continue;
          }
          const ctxTime = audio.ctxTimeAt(beatSongTime);
          audio.scheduleClick(ctxTime, bi % 4 === 0);
          lastScheduledBeatRef.current = bi;
        }
      }

      const rs = renderStateRef.current;
      for (let i = 0; i < rs.laneFlash.length; i++) {
        rs.laneFlash[i] = Math.max(0, rs.laneFlash[i] - dt * 4.5);
      }
      if (state) rs.recentEvents = state.events;

      // ---- Combo bookkeeping --------------------------------------------
      // The renderer reads rs.combo to size the on-canvas combo number;
      // we mirror it from the engine each frame. When the combo crosses one
      // of the milestone thresholds we also kick off a screen flash + chime
      // for the kind of "moment" feedback osu!mania uses to keep flow alive.
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

      // Mutate a single options object every frame instead of allocating a
      // fresh one (with a fresh laneHeld copy via [...spread]). The renderer
      // only reads laneHeld, so passing the ref directly is safe.
      renderOptsRef.current.bpm = songMeta.bpm;
      renderOptsRef.current.offset = songMeta.offset;
      renderOptsRef.current.laneHeld = heldRef.current;

      drawFrame(
        ctx,
        state ?? emptyStateRef.current,
        songTime,
        dt,
        renderOptsRef.current,
        rs,
      );

      if (state && now - lastHudUpdate > 100) {
        setStats({ ...state.stats });
        lastHudUpdate = now;
      }

      rafRef.current = requestAnimationFrame(loop);
    };

    function finishRun(state: GameState) {
      const songMeta = songRef.current.meta;
      const key = bestKey(songMeta.id, chartMode);
      const accuracy = computeAccuracy(state.stats);
      const result = saveBestIfHigher(key, {
        songId: songMeta.id,
        mode: chartMode,
        score: state.stats.score,
        accuracy,
        maxCombo: state.stats.maxCombo,
        at: Date.now(),
      });
      // Update lifetime aggregates (tracks played, total runs, all-time best)
      // so the homepage scoreboard reflects this run on next page load.
      recordRun({
        songId: songMeta.id,
        songTitle: songMeta.title,
        songArtist: songMeta.artist,
        mode: chartMode,
        score: state.stats.score,
        accuracy,
        maxCombo: state.stats.maxCombo,
      });
      setBest(result.best);
      setNewBest(result.improved);
      setPhase("results");
      setStats({ ...state.stats });
    }

    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [phase, chartMode]);

  // ---- Cleanup on unmount ----------------------------------------------
  useEffect(() => {
    return () => {
      audioRef.current?.stop();
    };
  }, []);

  const goHome = useCallback(() => {
    if (typeof window !== "undefined") window.location.href = "/";
  }, []);

  const restart = useCallback(() => {
    // Keep the AudioEngine + decoded buffer; just stop the current playback.
    // The "Try again" button thus goes from PLAY-click → first note in <50ms.
    audioRef.current?.stop();
    stateRef.current = null;
    resetRenderState(renderStateRef.current);
    heldRef.current.fill(false);
    prevComboRef.current = 0;
    lastScheduledBeatRef.current = -1;
    songRef.current = { meta: PLACEHOLDER_META, notes: [] };
    setSongSource(null);
    setChartLength(0);
    setStats(null);
    setNewBest(false);
    setPhase("idle");
  }, []);

  // Results-screen hotkeys: Enter / Space / R = retry, ESC = home.
  useEffect(() => {
    if (phase !== "results") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Enter" || e.code === "Space" || e.code === "KeyR") {
        e.preventDefault();
        restart();
      } else if (e.code === "Escape") {
        e.preventDefault();
        goHome();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, restart, goHome]);

  // ---- Render -----------------------------------------------------------
  return (
    <div className="relative h-full w-full">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 block h-full w-full"
      />

      {(phase === "playing" || phase === "countdown" || phase === "paused") &&
        stats && (
          <HUD
            stats={stats}
            metronome={metronome}
            onToggleMetronome={() => setMetronome((m) => !m)}
            best={best}
            volume={volume}
            onVolume={setVolume}
            onPause={pause}
            paused={phase === "paused"}
            fps={fps}
            fpsLock={fpsLock}
            onCycleFpsLock={() => setFpsLock((cur) => nextFpsLock(cur))}
            songTitle={displayMeta?.title ?? null}
            songArtist={displayMeta?.artist ?? null}
            chartMode={chartMode}
          />
        )}

      {/* On-screen lane buttons for touch devices. Hidden when a fine
          pointer is detected so the keyboard player never sees them. */}
      {touchOnly &&
        (phase === "playing" || phase === "countdown") && (
          <TouchLanes onPress={pressLane} onRelease={releaseLane} />
        )}

      {(phase === "idle" || phase === "loading") && (
        <Overlay>
          <StartCard
            meta={displayMeta}
            onStart={start}
            loading={phase === "loading"}
            error={error ?? previewError}
            metronome={metronome}
            onToggleMetronome={() => setMetronome((m) => !m)}
            songSource={songSource}
            chartMode={chartMode}
            onChangeMode={setChartMode}
            modeAvailability={modeAvailability}
            chartLength={chartLength}
            rawNoteCount={rawNoteCount}
            best={best}
            volume={volume}
            onVolume={setVolume}
            progressMsg={progressMsg}
            mirror={mirror}
            beatmapsetId={beatmapsetId}
            touchOnly={touchOnly}
          />
        </Overlay>
      )}

      {phase === "paused" && (
        <Overlay translucent>
          <PauseCard onResume={resume} onGiveUp={giveUp} />
        </Overlay>
      )}

      {phase === "countdown" && (
        <Overlay translucent>
          <div className="text-center">
            <p className="font-mono text-[0.79rem] uppercase tracking-[0.4em] text-accent">
              Get ready
            </p>
            <p className="mt-2 font-display text-[clamp(6.3rem,18.9vw,12.6rem)] font-bold leading-none text-bone-50 drop-shadow-[0_0_30px_rgba(61,169,255,0.6)]">
              {countdown}
            </p>
            <p className="mt-2 font-mono text-[0.79rem] uppercase tracking-widest text-bone-50/60">
              {touchOnly
                ? "tap the four lanes · hold for sustains"
                : "D F J K · or ← ↓ ↑ → · M = metronome · ESC = pause · hold for sustains"}
            </p>
          </div>
        </Overlay>
      )}

      {phase === "results" && stats && displayMeta && (
        <Overlay>
          <ResultsCard
            meta={displayMeta}
            stats={stats}
            best={best}
            newBest={newBest}
            onRetry={restart}
          />
        </Overlay>
      )}
    </div>
  );
}

/**
 * Returns true if the keyboard event target is an editable element
 * (input, textarea, contenteditable). We skip key handlers in that case so
 * typing into a future chat box / settings field doesn't fire lane keys
 * or pause the game.
 */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable;
}

/**
 * Reset all live render state to its initial "no run" shape *in place*.
 * We mutate the existing object instead of replacing it because the RAF
 * loop captures `renderStateRef.current` once per frame and we want every
 * subsequent frame to see the cleared arrays without needing to re-read
 * the ref. Keeps `cache` intact so the next run reuses the gradient cache
 * (canvas geometry hasn't changed; rebuilding would cause a 1-frame jank).
 */
function resetRenderState(rs: RenderState): void {
  rs.recentEvents = [];
  rs.laneFlash.fill(0);
  rs.laneAnticipation.fill(0);
  rs.particles.length = 0;
  rs.shockwaves.length = 0;
  rs.pendingHits.length = 0;
  rs.combo = 0;
  rs.milestone = null;
}

function computeAccuracy(stats: PlayerStats): number {
  const total = stats.notesPlayed || 1;
  return (
    ((stats.hits.perfect + stats.hits.great * 0.7 + stats.hits.good * 0.4) /
      total) *
    100
  );
}

// ---------------------------------------------------------------------------
function StartCard({
  meta,
  onStart,
  loading,
  error,
  metronome,
  onToggleMetronome,
  songSource,
  chartMode,
  onChangeMode,
  modeAvailability,
  chartLength,
  rawNoteCount,
  best,
  volume,
  onVolume,
  progressMsg,
  mirror,
  beatmapsetId,
  touchOnly,
}: {
  meta: SongMeta | null;
  onStart: () => void;
  loading: boolean;
  error: string | null;
  metronome: boolean;
  onToggleMetronome: () => void;
  songSource: "osu" | "fallback" | null;
  chartMode: ChartMode;
  onChangeMode: (m: ChartMode) => void;
  modeAvailability: ModeAvailability;
  chartLength: number;
  rawNoteCount: number;
  best: RunBest | null;
  volume: number;
  onVolume: (v: number) => void;
  progressMsg: string | null;
  mirror: string | null;
  beatmapsetId: number | null;
  /** Coarse-pointer device — swap "press D F J K" copy for tap copy and
   *  let the player know the on-screen lanes will appear during play. */
  touchOnly: boolean;
}) {
  const ready = meta !== null;
  const nps =
    meta && meta.duration > 0 ? (chartLength / meta.duration).toFixed(1) : "—";
  return (
    <div
      className="brut-card relative w-full max-w-xl overflow-hidden p-6 sm:p-8"
      style={
        ready && meta!.coverUrl
          ? {
              // Theme-aware overlay. Tints the cover with the page's
              // BASE color (`--bg`: cream in light mode, near-black
              // in dark mode) so the wash blends with whatever theme
              // the user is on, and the regular themed `--fg` text
              // (inherited from <body>) stays readable in either
              // direction without locking the card to one theme.
              //
              // Two layers:
              //   1. Vertical gradient — heavier wash at the title
              //      band (top) and the Start button band (bottom)
              //      where raw text sits directly on the cover,
              //      lighter in the middle 30–70% band where the
              //      inner panels (DIFFICULTY / BEST / METRONOME /
              //      VOLUME) supply their own translucent backing so
              //      the cover can show through between them.
              //   2. Flat dim across the whole card — a gentle
              //      contrast floor so bright cover highlights can't
              //      punch through and fight the text/buttons.
              //
              // 404s fall back to the card's own surface from
              // `.brut-card` — nothing to handle in JS.
              backgroundImage: `linear-gradient(180deg, rgb(var(--bg) / 0.90) 0%, rgb(var(--bg) / 0.45) 30%, rgb(var(--bg) / 0.45) 70%, rgb(var(--bg) / 0.92) 100%), linear-gradient(rgb(var(--bg) / 0.25), rgb(var(--bg) / 0.25)), url(${meta!.coverUrl})`,
              backgroundSize: "cover",
              backgroundPosition: "center",
            }
          : undefined
      }
    >
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-2">
          <p className="font-mono text-[10.5px] uppercase tracking-[0.4em] text-accent">
            {mirror ? "Random pick" : "Now playing"}
          </p>
          {ready && meta!.status && (
            <StatusBadge status={meta!.status} size="xs" />
          )}
        </div>
        {ready && songSource && (
          <span
            className="font-mono text-[9.5px] uppercase tracking-widest text-accent/70"
            title={
              mirror
                ? `Pulled from ${mirror} at runtime${meta!.creator ? ` · mapped by ${meta!.creator}` : ""}`
                : "Loaded from a real osu!mania 4K beatmap"
            }
          >
            {mirror ? `via ${mirror}` : "osu! 4K chart"}
          </span>
        )}
      </div>

      {ready ? (
        <>
          <h2
            className="mt-2 font-display text-[1.97rem] sm:text-[2.36rem] font-bold leading-none"
            style={
              meta!.coverUrl
                ? {
                    // Halo using the page base color — cream glow in
                    // light mode (lifts the dark title off bright
                    // cover highlights), black glow in dark mode
                    // (same idea, inverted).
                    textShadow: "0 2px 10px rgb(var(--bg) / 0.95)",
                  }
                : undefined
            }
          >
            {meta!.title}
          </h2>
          <p
            className="mt-1 text-[1.05rem]"
            style={
              meta!.coverUrl
                ? {
                    color: "rgb(var(--fg) / 0.85)",
                    textShadow: "0 1px 6px rgb(var(--bg) / 0.95)",
                  }
                : { color: "rgb(var(--fg) / 0.85)" }
            }
          >
            {meta!.artist}
            {meta!.year ? ` · ${meta!.year}` : ""}
            {beatmapsetId != null && (
              <a
                href={`https://osu.ppy.sh/beatmapsets/${beatmapsetId}`}
                target="_blank"
                rel="noreferrer"
                // Inline-flex + middle baseline so the brutalist arrow
                // glyph sits visually centered on the cap height of the
                // mono "#…" label rather than dropping below the
                // baseline like a unicode `↗` would. `align-middle` on
                // the icon nudges it up to optical center.
                className="ml-2 inline-flex items-center gap-1 font-mono text-[10.5px] uppercase tracking-widest text-bone-50/40 transition-colors hover:text-accent"
                title="Open on osu.ppy.sh"
              >
                <span>#{beatmapsetId}</span>
                <ArrowIcon
                  direction="up-right"
                  size={12}
                  strokeWidth={2.75}
                  className="align-middle"
                />
              </a>
            )}
          </p>
        </>
      ) : (
        <div className="mt-3 flex items-center gap-3">
          <Spinner />
          <div className="space-y-1">
            {progressMsg ? (
              <p className="font-mono text-[11.5px] uppercase tracking-widest text-bone-50/70">
                {progressMsg}
              </p>
            ) : (
              <div className="h-7 w-48 animate-pulse bg-bone-50/10" />
            )}
            <p className="font-mono text-[9.5px] tracking-widest text-bone-50/40">
              {progressMsg
                ? "first load downloads + unzips a 3\u20138 MB osu! beatmap"
                : "loading\u2026"}
            </p>
          </div>
        </div>
      )}

      <div className="mt-6 grid grid-cols-4 gap-2">
        <KeyCap primary="D" direction="left" color="#ff3b6b" />
        <KeyCap primary="F" direction="down" color="#ffd23f" />
        <KeyCap primary="J" direction="up" color="#3dff8a" />
        <KeyCap primary="K" direction="right" color="#3da9ff" />
      </div>
      <p className="mt-2 text-center font-mono text-[10.5px] uppercase tracking-widest text-bone-50/50">
        {touchOnly
          ? "tap the four lanes when notes hit the line · hold for sustains"
          : "D F J K or arrow keys · hold for long notes"}
      </p>
      {touchOnly && (
        <p className="mt-1 hidden text-center font-mono text-[10.5px] uppercase tracking-widest text-accent/70 portrait:block">
          ↻ rotate to landscape for more room
        </p>
      )}

      <div className="mt-5 border-2 border-bone-50/30 bg-ink-900/50 px-3 py-2">
        <div className="flex items-baseline justify-between gap-3">
          <span className="font-mono text-[11.5px] uppercase tracking-widest text-bone-50/70">
            Difficulty
          </span>
          <span className="font-mono text-[10.5px] text-bone-50/40">
            {chartLength} notes · {nps} nps
            {rawNoteCount > chartLength && (
              <span className="text-bone-50/30"> · raw {rawNoteCount}</span>
            )}
          </span>
        </div>
        {/* Picker = 5 fixed Syncle tiers. Top row holds the three "core"
            tiers everyone recognizes; bottom row holds the two top-end
            tiers (insane / expert) which only light up when the mapper
            actually shipped a chart at that level. Disabled buttons stay
            visible (line-through, dimmed) so the player sees the full
            ladder and understands what THIS song offers vs the next one. */}
        <div className="mt-2 grid grid-cols-3 gap-1">
          {(["easy", "normal", "hard"] as ChartMode[]).map((m) => (
            <ModeButton
              key={m}
              mode={m}
              enabled={modeAvailability.available[m]}
              selected={chartMode === m}
              onPick={onChangeMode}
            />
          ))}
        </div>
        <div className="mt-1 grid grid-cols-2 gap-1">
          {(["insane", "expert"] as ChartMode[]).map((m) => (
            <ModeButton
              key={m}
              mode={m}
              enabled={modeAvailability.available[m]}
              selected={chartMode === m}
              onPick={onChangeMode}
            />
          ))}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <div className="border-2 border-bone-50/30 bg-ink-900/50 px-3 py-2">
          <p className="font-mono text-[10.5px] uppercase tracking-widest text-bone-50/50">
            Best on this track
          </p>
          {best ? (
            <p className="mt-1 font-display text-[1.58rem] font-bold text-accent">
              {best.score.toLocaleString()}
            </p>
          ) : (
            <p className="mt-1 font-display text-[1.58rem] font-bold text-bone-50/30">
              —
            </p>
          )}
          <p className="font-mono text-[9.5px] text-bone-50/50">
            {best
              ? `${best.accuracy.toFixed(1)}% · ×${best.maxCombo} combo`
              : "no runs yet"}
          </p>
        </div>
        <label className="flex flex-col justify-between gap-1 border-2 border-bone-50/30 bg-ink-900/50 px-3 py-2 cursor-pointer">
          <div className="flex items-center justify-between gap-3">
            <span className="font-mono text-[10.5px] uppercase tracking-widest text-bone-50/70">
              Metronome
            </span>
            <input
              type="checkbox"
              checked={metronome}
              onChange={onToggleMetronome}
              className="h-[1.05rem] w-[1.05rem] accent-accent"
            />
          </div>
          <span className="font-mono text-[9.5px] text-bone-50/40">
            press M to toggle in-game
          </span>
        </label>
      </div>

      <div className="mt-3 border-2 border-bone-50/30 bg-ink-900/50 px-3 py-2">
        <div className="flex items-center justify-between gap-3">
          <span className="font-mono text-[10.5px] uppercase tracking-widest text-bone-50/70">
            Music volume
          </span>
          <span className="font-mono text-[10.5px] text-bone-50/40 tabular-nums">
            {Math.round(volume * 100)}%
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={(e) => onVolume(parseFloat(e.target.value))}
          className="mt-1.5 h-1 w-full cursor-pointer accent-accent"
          aria-label="Music volume"
        />
      </div>

      {error && (
        <p className="mt-4 border-2 border-rose-500 p-2 font-mono text-[0.78rem] text-rose-400">
          {error}
        </p>
      )}

      <button
        onClick={onStart}
        disabled={loading || !ready}
        className="brut-btn-accent group mt-6 flex w-full items-center justify-center gap-2 px-6 py-4 text-[1.05rem] sm:text-[1.18rem] disabled:opacity-50"
      >
        {loading || !ready ? (
          <>
            <Spinner small />
            <span>{loading ? "Loading audio..." : "Loading chart..."}</span>
          </>
        ) : (
          <>
            <span>{best ? "Try again" : "Start"}</span>
            {/* Play triangle moved AFTER the label and given the same
                slide-on-hover treatment as the arrow icons elsewhere
                (Back / Join room). Wrapped in a span so we can apply
                a transform — the unicode glyph itself is positionable
                only via its container. `inline-block` is required for
                translate-x to take effect (transforms are no-ops on
                inline elements). */}
            <span
              aria-hidden
              className="inline-block transition-transform duration-200 group-hover:translate-x-0.5"
            >
              ▶
            </span>
          </>
        )}
      </button>
      <p className="mt-3 text-center font-mono text-[10.5px] uppercase tracking-widest text-bone-50/40">
        Replay as many times as you want!
      </p>
    </div>
  );
}

/**
 * Single difficulty button in the StartCard picker. Pulled out so the
 * top row (easy/medium/hard) and the bottom row (insane/expert) share
 * exactly the same styling + interaction logic and the picker JSX stays
 * skim-able.
 *
 * Style precedence is INTENTIONAL: `!enabled` beats `selected`. While
 * the chart is still loading every tier reports `enabled=false`, but
 * `chartMode` already holds the default (`easy`) — without this
 * ordering the default tier would paint in accent blue and read as
 * "ready to play" before the picker actually has any data.
 */
function ModeButton({
  mode,
  enabled,
  selected,
  onPick,
}: {
  mode: ChartMode;
  enabled: boolean;
  selected: boolean;
  onPick: (m: ChartMode) => void;
}) {
  const stars = modeStars(mode);
  return (
    <button
      onClick={() => enabled && onPick(mode)}
      disabled={!enabled}
      title={
        enabled
          ? `${displayMode(mode).toUpperCase()} · ${stars} / 5 intensity`
          : `This song doesn't ship a ${displayMode(mode)} chart.`
      }
      className={`flex flex-col items-center justify-center gap-0.5 font-mono text-[10.5px] uppercase tracking-widest border-2 py-1.5 transition-colors ${
        !enabled
          ? // Distinct "unavailable" treatment: dashed border + much
            // dimmer text/stars. Reads as obviously off vs the solid
            // outline of an unselected-but-available tier (which the
            // player CAN click). The dashed stroke is the brutalist
            // "this slot exists in the layout but not for you" tell;
            // dropping text alpha to /35 (vs /60 unselected) makes
            // the diff impossible to miss in a glance, even on top
            // of busy cover-art backgrounds.
            "border-dashed border-bone-50/20 text-bone-50/35 cursor-not-allowed bg-ink-900/40"
          : selected
            ? "border-accent bg-accent text-ink-900"
            : "border-bone-50/30 text-bone-50/60 hover:border-bone-50/60 bg-ink-900/40"
      }`}
    >
      <span>{displayMode(mode)}</span>
      {/* Stars are rendered as a fixed 5-slot row (filled vs hollow) so
          every button is the same width regardless of tier — otherwise
          Easy (★) would be visibly narrower than Expert (★★★★★) and
          the picker grid would feel uneven. Disabled tiers fade the
          whole star row further so it doesn't fight the dimmed name
          for attention. */}
      <span
        aria-hidden
        className={`text-[8.5px] leading-none tracking-[0.2em] ${enabled ? "" : "opacity-60"}`}
      >
        {"★".repeat(stars)}
        <span className="opacity-30">{"★".repeat(5 - stars)}</span>
      </span>
    </button>
  );
}

/**
 * Compact `EASY ★★` style badge used in the in-game HUD to remind the
 * player which tier they picked at the lobby. Mirrors the picker's
 * label format (name + filled-vs-hollow stars) so the player can map
 * the badge back to the picker button without re-reading legend text.
 *
 * Visual: bordered + accent-tinted so it reads as a "tag" rather than
 * inline copy. Stays small enough not to fight the song title for the
 * eye in the rock-meter card.
 */
function DifficultyTag({ mode }: { mode: ChartMode }) {
  const stars = modeStars(mode);
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 border border-accent/60 px-1 py-0.5 font-mono text-[8.2px] uppercase tracking-widest text-accent sm:text-[9.2px]"
      title={`Difficulty: ${displayMode(mode)} (${stars} / 5 intensity)`}
    >
      <span>{displayMode(mode)}</span>
      <span aria-hidden className="leading-none tracking-[0.15em]">
        {"★".repeat(stars)}
        <span className="opacity-30">{"★".repeat(5 - stars)}</span>
      </span>
    </span>
  );
}

function Spinner({ small }: { small?: boolean }) {
  const size = small ? 15 : 21;
  return (
    <span
      role="status"
      aria-label="Loading"
      className="inline-block animate-spin rounded-full border-2 border-bone-50/20 border-t-accent"
      style={{ width: size, height: size }}
    />
  );
}

/**
 * Given the user's currently selected mode + the song's per-mode availability,
 * return the mode the picker should actually use.
 *
 * Strategy: keep `requested` if it's available, else walk UP the ladder
 * (toward harder tiers) first because falling forward usually yields a
 * meaningfully distinct chart; if everything above is also disabled
 * (sparse song shipping only an Easy chart, for example) walk DOWN as
 * a last resort. At least one tier is always available because
 * `parsedCharts.length > 0` means at least one bucket is mapper-filled.
 */
function pickAvailableMode(
  requested: ChartMode,
  modes: ModeAvailability,
): ChartMode {
  if (modes.available[requested]) return requested;
  let i = MODE_ORDER.indexOf(requested);
  if (i < 0) i = 0;
  for (let j = i + 1; j < MODE_ORDER.length; j++) {
    if (modes.available[MODE_ORDER[j]]) return MODE_ORDER[j];
  }
  for (let j = i - 1; j >= 0; j--) {
    if (modes.available[MODE_ORDER[j]]) return MODE_ORDER[j];
  }
  return requested;
}

function KeyCap({
  primary,
  direction,
  color,
}: {
  primary: string;
  direction: ArrowDirection;
  color: string;
}) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-1 border-2 py-3"
      style={{ borderColor: color, color }}
    >
      <span className="font-mono text-[1.31rem] font-bold leading-none">
        {primary}
      </span>
      <ArrowIcon
        direction={direction}
        size={15}
        strokeWidth={2.75}
        style={{ opacity: 0.75 }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
function HUD({
  stats,
  metronome,
  onToggleMetronome,
  best,
  volume,
  onVolume,
  onPause,
  paused,
  fps,
  fpsLock,
  onCycleFpsLock,
  songTitle,
  songArtist,
  chartMode,
}: {
  stats: PlayerStats;
  metronome: boolean;
  onToggleMetronome: () => void;
  best: RunBest | null;
  volume: number;
  onVolume: (v: number) => void;
  onPause: () => void;
  paused: boolean;
  fps: number;
  fpsLock: FpsLock;
  onCycleFpsLock: () => void;
  songTitle: string | null;
  songArtist: string | null;
  chartMode: ChartMode;
}) {
  const accuracy = computeAccuracy(stats);
  const total = stats.totalNotes;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-10 mx-auto flex w-full max-w-6xl items-start justify-between gap-2 p-2 sm:gap-3 sm:p-5">
      {/* Combined SCORE + COMBO panel. Same accented chrome as before, but
          combo sits inside the same frame with a dividing rule, so the
          left HUD reads as one cohesive "performance" block instead of
          two competing cards. Internal min-widths shrink at <sm so the
          panel fits 4-lane phones in landscape without crowding the
          rock-meter card on the right. */}
      <div className="brut-card-accent flex items-stretch gap-2 px-2.5 py-2 sm:gap-4 sm:px-4 sm:py-3">
        <div className="min-w-[89px] sm:min-w-[153px]">
          <p className="font-mono text-[9.2px] uppercase tracking-widest text-bone-50/60 sm:text-[10.2px]">
            Score
          </p>
          <p className="font-display text-[1.27rem] font-bold leading-none sm:text-[1.91rem]">
            {stats.score.toLocaleString()}
          </p>
          <p className="mt-1 font-mono text-[9.2px] text-bone-50/60 sm:text-[10.2px]">
            {accuracy.toFixed(1)}% · {stats.notesPlayed}/{total}
          </p>
          {best && (
            <p className="mt-1 hidden font-mono text-[9.2px] uppercase tracking-widest text-bone-50/50 sm:block">
              track best {best.score.toLocaleString()}
            </p>
          )}
        </div>
        <div className="w-px shrink-0 bg-bone-50/20" aria-hidden />
        <div className="flex min-w-[57px] flex-col items-center justify-center sm:min-w-[81px]">
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

      <div className="brut-card flex w-[143px] flex-col gap-1 px-2.5 py-2 sm:w-[204px] sm:px-4 sm:py-3">
        {/* "Now playing" strip — single source of truth for which song is on
            screen during gameplay (the StartCard hands off and disappears,
            so without this the player has nothing to remind them what's
            currently rolling). Title/artist are truncated with `min-w-0` +
            `truncate` so the brutalist border stays sharp at every width;
            full text shows in the native title tooltip on hover. */}
        {songTitle && (
          <div className="flex min-w-0 flex-col border-b-2 border-bone-50/15 pb-1.5">
            {/* Top row: "♪ Now playing" label on the left, current
                difficulty tag on the right. We keep the tag inside the
                same card (top-right) instead of absolute-positioning
                it over the card chrome — that way the song title row
                below always has predictable horizontal space and the
                tag never collides with a long title. The tag mirrors
                the picker's `EASY ★★` format so the player can map
                the in-game label back to the lobby button at a glance. */}
            <div className="flex items-center justify-between gap-2">
              <p className="truncate font-mono text-[8.2px] uppercase tracking-widest text-bone-50/45 sm:text-[9.2px]">
                ♪ Now playing
              </p>
              <DifficultyTag mode={chartMode} />
            </div>
            <p
              className="truncate font-mono text-[10.2px] font-bold text-bone-50/90 sm:text-[11.2px]"
              title={`${songTitle}${songArtist ? ` — ${songArtist}` : ""}`}
            >
              {songTitle}
            </p>
            {songArtist && (
              <p
                className="truncate font-mono text-[9.2px] text-bone-50/50 sm:text-[10.2px]"
                title={songArtist}
              >
                {songArtist}
              </p>
            )}
          </div>
        )}
        <div className="flex items-center justify-between gap-1 sm:gap-2">
          <p className="font-mono text-[9.2px] uppercase tracking-widest text-bone-50/60 sm:text-[10.2px]">
            Rock meter
          </p>
          <div className="flex gap-1">
            <button
              onClick={onToggleMetronome}
              className={`pointer-events-auto font-mono text-[9.2px] uppercase tracking-widest border px-1 py-0.5 transition-colors sm:px-1.5 ${
                metronome
                  ? "border-accent text-accent"
                  : "border-bone-50/30 text-bone-50/40"
              }`}
              title="Toggle metronome (M)"
              aria-label="Toggle metronome"
            >
              ♩<span className="hidden sm:inline"> {metronome ? "ON" : "OFF"}</span>
            </button>
            <button
              onClick={onPause}
              disabled={paused}
              className="pointer-events-auto font-mono text-[9.2px] uppercase tracking-widest border border-bone-50/40 px-1 py-0.5 text-bone-50/80 transition-colors hover:border-accent hover:text-accent disabled:opacity-40 sm:px-1.5"
              title="Pause (ESC)"
              aria-label="Pause"
            >
              ❚❚<span className="hidden sm:inline"> ESC</span>
            </button>
          </div>
        </div>
        <div className="relative h-[0.78rem] w-full border-2 border-bone-50/40">
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
        <div className="mt-1 flex items-center gap-1.5 sm:gap-2">
          <span className="font-mono text-[9.2px] uppercase tracking-widest text-bone-50/50">
            vol
          </span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={(e) => onVolume(parseFloat(e.target.value))}
            // min-w-0 is critical: <input type="range"> has a UA-set
            // intrinsic min-width (~120px) that overrides flex-shrink, so
            // without it the slider pokes past the card's right edge on
            // narrow viewports (mobile rock-meter card is only ~143px).
            className="pointer-events-auto h-1 min-w-0 flex-1 cursor-pointer accent-accent"
            aria-label="Music volume"
          />
          <span className="hidden sm:inline font-mono text-[9.2px] tabular-nums text-bone-50/40 w-7 text-right">
            {Math.round(volume * 100)}
          </span>
        </div>
        <div className="hidden items-center justify-end gap-1.5 sm:flex">
          {/* FPS lock toggle — clicking cycles off → 30 → 60 → off. The
              uncapped state is intentionally a dim "OFF" pill so the
              eye doesn't read it as the active option; the locked
              states get the brand accent so the player can confirm at
              a glance which cap is in effect. */}
          <button
            onClick={onCycleFpsLock}
            type="button"
            className={`pointer-events-auto font-mono text-[9.2px] uppercase tracking-widest border px-1 py-0.5 transition-colors sm:px-1.5 ${
              fpsLock == null
                ? "border-bone-50/30 text-bone-50/50 hover:border-bone-50/60 hover:text-bone-50/80"
                : "border-accent text-accent"
            }`}
            title={
              fpsLock == null
                ? "FPS lock off — click to cap at 30 FPS"
                : `Render frame-rate capped at ${fpsLock} FPS — click to ${
                    fpsLock === 30 ? "cap at 60" : "uncap"
                  }`
            }
            aria-label="Cycle render FPS lock"
          >
            LOCK·{fpsLock == null ? "OFF" : fpsLock}
          </button>
          <span
            className={`font-mono text-[9.2px] tabular-nums tracking-widest ${
              fps >= 55
                ? "text-bone-50/40"
                : fps >= 40
                ? "text-yellow-400/70"
                : "text-rose-400/80"
            }`}
            title="Render frames per second"
          >
            {fps || "—"} FPS
          </span>
        </div>
      </div>
    </div>
  );
}

function PauseCard({
  onResume,
  onGiveUp,
}: {
  onResume: () => void;
  onGiveUp: () => void;
}) {
  return (
    <div className="brut-card w-full max-w-md p-6 sm:p-8 text-center">
      <p className="font-mono text-[10.5px] uppercase tracking-[0.4em] text-accent">
        Paused
      </p>
      <h2 className="mt-2 font-display text-[3.15rem] font-bold leading-none">
        ❚❚
      </h2>
      <p className="mt-3 font-mono text-[0.79rem] uppercase tracking-widest text-bone-50/60">
        Audio is suspended — take your time
      </p>
      <div className="mt-6 grid grid-cols-2 gap-3">
        <button onClick={onResume} className="brut-btn-accent px-4 py-3">
          ▶ Resume
        </button>
        <button onClick={onGiveUp} className="brut-btn px-4 py-3">
          ✕ Give up
        </button>
      </div>
      <p className="mt-3 font-mono text-[10.5px] uppercase tracking-widest text-bone-50/40">
        ESC = resume · giving up doesn&rsquo;t save the run
      </p>
    </div>
  );
}

/**
 * On-screen lane buttons for touch devices.
 *
 * Four full-bleed columns sit over the bottom two-thirds of the canvas,
 * directly under the lane gates. Each one fires `onPress(lane)` on
 * pointerdown and `onRelease(lane)` on pointerup/cancel — the same
 * functions the keyboard handler uses, so hold notes work identically to
 * keyboard play (touchstart → keydown analogue, touchend → keyup analogue).
 *
 * Implementation notes:
 *   - We use Pointer Events (covers mouse + touch + pen) and call
 *     `setPointerCapture` so the matching pointerup is guaranteed to fire
 *     on the same element even if the finger drifts off the column.
 *   - `touchAction: "none"` prevents the browser from claiming a finger
 *     for scroll/zoom gestures during play.
 *   - The container is `pointer-events-none` so empty space above the
 *     buttons doesn't trap clicks meant for HUD controls; the buttons
 *     themselves re-enable pointer events.
 *   - Visuals are intentionally minimal — the canvas already paints the
 *     lane gates in vivid colour. The buttons add a faint top border and
 *     a brief tint while pressed so the player gets a finger-shadow cue
 *     without visually competing with the highway.
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

/**
 * Full-bleed dim layer used to host modal cards (StartCard, PauseCard,
 * ResultsCard, countdown). Two responsive concerns it has to balance:
 *
 *   1. When the card fits, it should be perfectly centered.
 *   2. When the card is taller than the available area (mid-laptop heights,
 *      DevTools open, mobile landscape), `items-center` would push the top
 *      of the card past the parent's top edge — and because <main> uses
 *      overflow-hidden the overflow doesn't scroll, it just *clips* and
 *      visually crosses over the header. Bug we hit on ~720px tall viewports.
 *
 * Pattern below: outer scroll container + inner `min-h-full` flex centerer.
 *   - Short card → flex centers it, no scrollbar.
 *   - Tall card → inner min-h-full forces the column to be at least the
 *     overlay height, content extends downward, scrollbar appears, top of
 *     the card stays anchored at the top with breathing-room padding.
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
        translucent
          ? "bg-ink-900/40 backdrop-blur-sm"
          : "bg-ink-900/80 backdrop-blur"
      }`}
    >
      <div className="flex min-h-full items-center justify-center px-4 py-6 sm:px-6 sm:py-8">
        {children}
      </div>
    </div>
  );
}

function ResultsCard({
  meta,
  stats,
  best,
  newBest,
  onRetry,
}: {
  meta: SongMeta;
  stats: PlayerStats;
  best: RunBest | null;
  newBest: boolean;
  onRetry: () => void;
}) {
  const accuracy = computeAccuracy(stats);
  const grade =
    accuracy >= 95
      ? "S"
      : accuracy >= 88
      ? "A"
      : accuracy >= 78
      ? "B"
      : accuracy >= 65
      ? "C"
      : accuracy >= 50
      ? "D"
      : "F";

  return (
    <div className="brut-card-accent w-full max-w-lg p-6 sm:p-8">
      <p className="font-mono text-[0.79rem] uppercase tracking-[0.4em] text-accent">
        {newBest ? "★ New track best" : "Run complete"}
      </p>
      <div className="mt-2 flex items-baseline justify-between">
        <h2 className="font-display text-[1.97rem] sm:text-[2.36rem] font-bold">
          {meta.title}
        </h2>
        <span
          className={`font-display text-[3.95rem] sm:text-[4.74rem] font-bold leading-none ${
            grade === "S"
              ? "text-accent"
              : grade === "F"
              ? "text-rose-400"
              : "text-bone-50"
          }`}
        >
          {grade}
        </span>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3 font-mono text-[0.92rem]">
        <Row label="Score" value={stats.score.toLocaleString()} accent />
        <Row label="Accuracy" value={`${accuracy.toFixed(2)}%`} />
        <Row label="Max combo" value={stats.maxCombo.toString()} />
        <Row label="Notes" value={`${stats.notesPlayed}/${stats.totalNotes}`} />
        <Row label="Perfect" value={stats.hits.perfect.toString()} />
        <Row label="Great" value={stats.hits.great.toString()} />
        <Row label="Good" value={stats.hits.good.toString()} />
        <Row label="Miss" value={stats.hits.miss.toString()} />
      </div>

      {best && (
        <div className="mt-4 border-2 border-bone-50/20 px-3 py-2">
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-mono text-[10.5px] uppercase tracking-widest text-bone-50/60">
              Best on this track
            </span>
            <span className="font-mono text-[0.92rem] text-accent">
              {best.score.toLocaleString()}
            </span>
          </div>
          <p className="mt-0.5 font-mono text-[10.5px] text-bone-50/40">
            {best.accuracy.toFixed(1)}% · ×{best.maxCombo} combo
            {newBest && (
              <span className="ml-2 text-accent">· you just set this</span>
            )}
          </p>
        </div>
      )}

      <div className="mt-6 flex gap-3">
        <button onClick={onRetry} className="brut-btn flex-1 px-6 py-3">
          Try again
        </button>
        <a href="/" className="brut-btn-accent flex-1 px-6 py-3 text-center">
          Home
        </a>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between border-b border-bone-50/15 pb-1.5">
      <span className="text-[10.5px] uppercase tracking-widest text-bone-50/50">
        {label}
      </span>
      <span className={accent ? "text-accent font-bold" : "text-bone-50"}>
        {value}
      </span>
    </div>
  );
}
