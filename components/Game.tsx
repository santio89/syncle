"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AudioEngine } from "@/lib/game/audio";
import { GameState, isHold } from "@/lib/game/engine";
import {
  ChartMode,
  loadSong,
  ModeAvailability,
  PLACEHOLDER_META,
  prefetchAudio,
} from "@/lib/game/chart";
import {
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
import { loadVolume, saveVolume } from "@/lib/game/settings";
import { useTheme } from "@/components/ThemeProvider";
import { ArrowIcon, type ArrowDirection } from "@/components/icons/ArrowIcon";

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
  const renderStateRef = useRef<RenderState>({
    recentEvents: [],
    laneFlash: new Array(TOTAL_LANES).fill(0),
    particles: [],
    pendingHits: [],
  });
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
    noteCounts: { easy: 0, normal: 0, hard: 0 },
    available: { easy: true, normal: true, hard: true },
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
  /** True if the user is on a touch-only device (no physical keyboard). */
  const [touchOnly, setTouchOnly] = useState<boolean>(false);
  /** Acknowledged the "no keyboard" warning and wants to try anyway. */
  const [touchAck, setTouchAck] = useState<boolean>(false);

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

  // Hydrate persisted volume + detect touch-only devices on mount.
  useEffect(() => {
    setVolume(loadVolume());
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
    renderStateRef.current.recentEvents = [];
    renderStateRef.current.laneFlash.fill(0);
    renderStateRef.current.particles.length = 0;
    renderStateRef.current.pendingHits.length = 0;
    heldRef.current.fill(false);
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
  useEffect(() => {
    if (phase !== "playing" && phase !== "countdown" && phase !== "paused")
      return;

    const onKeyDown = (e: KeyboardEvent) => {
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
      heldRef.current[lane] = true;

      if (phase !== "playing") return;
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
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (phase === "paused") return;
      const lane = KEY_TO_LANE[e.code];
      if (lane === undefined) return;
      heldRef.current[lane] = false;

      if (phase !== "playing") return;
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
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [phase, pause, resume]);

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
    renderStateRef.current.recentEvents = [];
    renderStateRef.current.laneFlash.fill(0);
    renderStateRef.current.particles.length = 0;
    renderStateRef.current.pendingHits.length = 0;
    heldRef.current.fill(false);
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
          />
        )}

      {(phase === "idle" || phase === "loading") && (
        <Overlay>
          {touchOnly && !touchAck ? (
            <TouchWarning onContinue={() => setTouchAck(true)} />
          ) : (
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
            />
          )}
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
            <p className="font-mono text-xs uppercase tracking-[0.4em] text-accent">
              Get ready
            </p>
            <p className="mt-2 font-display text-[clamp(6rem,18vw,12rem)] font-bold leading-none text-bone-50 drop-shadow-[0_0_30px_rgba(61,169,255,0.6)]">
              {countdown}
            </p>
            <p className="mt-2 font-mono text-xs uppercase tracking-widest text-bone-50/60">
              D F J K · or ← ↓ ↑ → · M = metronome · ESC = pause · hold for sustains
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
}) {
  const ready = meta !== null;
  const nps =
    meta && meta.duration > 0 ? (chartLength / meta.duration).toFixed(1) : "—";
  return (
    <div className="brut-card w-full max-w-xl p-6 sm:p-8">
      <div className="flex items-baseline justify-between gap-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-accent">
          {mirror ? "Random pick" : "Now playing"}
        </p>
        {ready && songSource && (
          <span
            className="font-mono text-[9px] uppercase tracking-widest text-accent/70"
            title={
              mirror
                ? `Pulled from ${mirror} at runtime`
                : "Loaded from a real osu!mania 4K beatmap"
            }
          >
            {mirror ? `via ${mirror}` : "osu! 4K chart"}
          </span>
        )}
      </div>

      {ready ? (
        <>
          <h2 className="mt-2 font-display text-3xl sm:text-4xl font-bold leading-none">
            {meta!.title}
          </h2>
          <p className="mt-1 text-bone-50/70">
            {meta!.artist}
            {meta!.year ? ` · ${meta!.year}` : ""}
            {beatmapsetId != null && (
              <a
                href={`https://osu.ppy.sh/beatmapsets/${beatmapsetId}`}
                target="_blank"
                rel="noreferrer"
                className="ml-2 font-mono text-[10px] uppercase tracking-widest text-bone-50/40 hover:text-accent"
                title="Open on osu.ppy.sh"
              >
                #{beatmapsetId} ↗
              </a>
            )}
          </p>
        </>
      ) : (
        <div className="mt-3 flex items-center gap-3">
          <Spinner />
          <div className="space-y-1">
            {progressMsg ? (
              <p className="font-mono text-[11px] uppercase tracking-widest text-bone-50/70">
                {progressMsg}
              </p>
            ) : (
              <div className="h-7 w-48 animate-pulse bg-bone-50/10" />
            )}
            <p className="font-mono text-[9px] tracking-widest text-bone-50/40">
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
      <p className="mt-2 text-center font-mono text-[10px] uppercase tracking-widest text-bone-50/50">
        D F J K or arrow keys · hold for long notes
      </p>

      <div className="mt-5 border-2 border-bone-50/20 px-3 py-2">
        <div className="flex items-baseline justify-between gap-3">
          <span className="font-mono text-[11px] uppercase tracking-widest text-bone-50/70">
            Difficulty
          </span>
          <span className="font-mono text-[10px] text-bone-50/40">
            {chartLength} notes · {nps}/sec
            {rawNoteCount > chartLength && (
              <span className="text-bone-50/30"> · raw {rawNoteCount}</span>
            )}
          </span>
        </div>
        <div className="mt-2 grid grid-cols-3 gap-1">
          {(["easy", "normal", "hard"] as ChartMode[]).map((m) => {
            const enabled = modeAvailability.available[m];
            const selected = chartMode === m;
            return (
              <button
                key={m}
                onClick={() => enabled && onChangeMode(m)}
                disabled={!enabled}
                title={
                  enabled
                    ? undefined
                    : "This song's chart is too sparse for a distinct " +
                      m +
                      " mode — try a denser difficulty."
                }
                className={`font-mono text-[10px] uppercase tracking-widest border-2 py-1.5 transition-colors ${
                  selected
                    ? "border-accent bg-accent text-ink-900"
                    : enabled
                      ? "border-bone-50/30 text-bone-50/60 hover:border-bone-50/60"
                      : "border-bone-50/10 text-bone-50/25 cursor-not-allowed line-through decoration-1"
                }`}
              >
                {m === "easy" ? "easy ★" : m === "normal" ? "normal ★★" : "hard ★★★"}
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <div className="border-2 border-bone-50/20 px-3 py-2">
          <p className="font-mono text-[10px] uppercase tracking-widest text-bone-50/50">
            Best on this track
          </p>
          {best ? (
            <p className="mt-1 font-display text-2xl font-bold text-accent">
              {best.score.toLocaleString()}
            </p>
          ) : (
            <p className="mt-1 font-display text-2xl font-bold text-bone-50/30">
              —
            </p>
          )}
          <p className="font-mono text-[9px] text-bone-50/50">
            {best
              ? `${best.accuracy.toFixed(1)}% · ×${best.maxCombo} combo`
              : "no runs yet"}
          </p>
        </div>
        <label className="flex flex-col justify-between gap-1 border-2 border-bone-50/20 px-3 py-2 cursor-pointer">
          <div className="flex items-center justify-between gap-3">
            <span className="font-mono text-[10px] uppercase tracking-widest text-bone-50/70">
              Metronome
            </span>
            <input
              type="checkbox"
              checked={metronome}
              onChange={onToggleMetronome}
              className="h-4 w-4 accent-accent"
            />
          </div>
          <span className="font-mono text-[9px] text-bone-50/40">
            press M to toggle in-game
          </span>
        </label>
      </div>

      <div className="mt-3 border-2 border-bone-50/20 px-3 py-2">
        <div className="flex items-center justify-between gap-3">
          <span className="font-mono text-[10px] uppercase tracking-widest text-bone-50/70">
            Music volume
          </span>
          <span className="font-mono text-[10px] text-bone-50/40 tabular-nums">
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
        <p className="mt-4 border-2 border-rose-500 p-2 font-mono text-xs text-rose-400">
          {error}
        </p>
      )}

      <button
        onClick={onStart}
        disabled={loading || !ready}
        className="brut-btn-accent mt-6 flex w-full items-center justify-center gap-2 px-6 py-4 text-base sm:text-lg disabled:opacity-50"
      >
        {loading || !ready ? (
          <>
            <Spinner small />
            <span>{loading ? "Loading audio..." : "Loading chart..."}</span>
          </>
        ) : (
          <span>{best ? "▶ Try again" : "▶ Start"}</span>
        )}
      </button>
      <p className="mt-3 text-center font-mono text-[10px] uppercase tracking-widest text-bone-50/40">
        Replay as many times as you want — only your best counts
      </p>
    </div>
  );
}

function Spinner({ small }: { small?: boolean }) {
  const size = small ? 14 : 20;
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
 * return the mode the picker should actually use. If the requested mode is
 * available we keep it; otherwise we walk toward "hard" (the only mode that
 * is always available) so the user lands on a chart that's distinct from the
 * one they were on. Walking toward hard is intentional: each fallback step
 * yields the exact same chart the disabled mode would have produced.
 */
function pickAvailableMode(
  requested: ChartMode,
  modes: ModeAvailability,
): ChartMode {
  const order: ChartMode[] = ["easy", "normal", "hard"];
  let i = order.indexOf(requested);
  if (i < 0) i = 0;
  while (i < order.length && !modes.available[order[i]]) i++;
  return order[Math.min(i, order.length - 1)];
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
      <span className="font-mono text-xl font-bold leading-none">{primary}</span>
      <ArrowIcon
        direction={direction}
        size={14}
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
}) {
  const accuracy = computeAccuracy(stats);
  const total = stats.totalNotes;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-10 mx-auto flex w-full max-w-6xl items-start justify-between gap-3 p-3 sm:p-5">
      <div className="brut-card-accent px-4 py-3 min-w-[160px]">
        <p className="font-mono text-[10px] uppercase tracking-widest text-bone-50/60">
          Score
        </p>
        <p className="font-display text-2xl sm:text-3xl font-bold leading-none">
          {stats.score.toLocaleString()}
        </p>
        <p className="mt-1 font-mono text-[10px] text-bone-50/60">
          {accuracy.toFixed(1)}% · {stats.notesPlayed}/{total}
        </p>
        {best && (
          <p className="mt-1 font-mono text-[9px] uppercase tracking-widest text-bone-50/50">
            track best {best.score.toLocaleString()}
          </p>
        )}
      </div>

      <div className="brut-card flex flex-col items-center px-4 py-3 min-w-[120px]">
        <p className="font-mono text-[10px] uppercase tracking-widest text-bone-50/60">
          Combo
        </p>
        <p
          className={`font-display text-3xl sm:text-4xl font-bold leading-none ${
            stats.combo > 0 ? "text-accent" : "text-bone-50/40"
          }`}
        >
          {stats.combo}
        </p>
        <p className="mt-1 font-mono text-xs font-bold text-accent">
          ×{stats.multiplier}
        </p>
      </div>

      <div className="brut-card flex w-[200px] flex-col gap-1 px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <p className="font-mono text-[10px] uppercase tracking-widest text-bone-50/60">
            Rock meter
          </p>
          <div className="flex gap-1">
            <button
              onClick={onToggleMetronome}
              className={`pointer-events-auto font-mono text-[9px] uppercase tracking-widest border px-1.5 py-0.5 transition-colors ${
                metronome
                  ? "border-accent text-accent"
                  : "border-bone-50/30 text-bone-50/40"
              }`}
              title="Toggle metronome (M)"
            >
              ♩ {metronome ? "ON" : "OFF"}
            </button>
            <button
              onClick={onPause}
              disabled={paused}
              className="pointer-events-auto font-mono text-[9px] uppercase tracking-widest border border-bone-50/40 px-1.5 py-0.5 text-bone-50/80 transition-colors hover:border-accent hover:text-accent disabled:opacity-40"
              title="Pause (ESC)"
            >
              ❚❚ ESC
            </button>
          </div>
        </div>
        <div className="relative h-3 w-full border-2 border-bone-50/40">
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
      <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-accent">
        Paused
      </p>
      <h2 className="mt-2 font-display text-5xl font-bold leading-none">
        ❚❚
      </h2>
      <p className="mt-3 font-mono text-xs uppercase tracking-widest text-bone-50/60">
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
      <p className="mt-3 font-mono text-[10px] uppercase tracking-widest text-bone-50/40">
        ESC = resume · giving up doesn&rsquo;t save the run
      </p>
    </div>
  );
}

function TouchWarning({ onContinue }: { onContinue: () => void }) {
  return (
    <div className="brut-card w-full max-w-md p-6 sm:p-8 text-center">
      <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-accent">
        Heads up
      </p>
      <h2 className="mt-2 font-display text-2xl font-bold leading-tight">
        Syncle needs a keyboard.
      </h2>
      <p className="mt-3 text-sm text-bone-50/70">
        Touch input isn&rsquo;t supported yet. For the best feel, open this on
        a laptop or desktop and use the <span className="text-accent font-bold">D&nbsp;F&nbsp;J&nbsp;K</span> keys
        (or arrow keys).
      </p>
      <div className="mt-5 grid grid-cols-2 gap-3">
        <a href="/" className="brut-btn group inline-flex items-center justify-center gap-2 px-4 py-3 text-center">
          <ArrowIcon
            direction="left"
            size={14}
            strokeWidth={2.75}
            className="transition-transform duration-200 group-hover:-translate-x-0.5"
          />
          <span>Back</span>
        </a>
        <button onClick={onContinue} className="brut-btn-accent px-4 py-3">
          Continue anyway
        </button>
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
      className={`absolute inset-0 z-20 flex items-center justify-center px-4 sm:px-6 ${
        translucent
          ? "bg-ink-900/40 backdrop-blur-sm"
          : "bg-ink-900/80 backdrop-blur"
      }`}
    >
      {children}
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
      <p className="font-mono text-xs uppercase tracking-[0.4em] text-accent">
        {newBest ? "★ New track best" : "Run complete"}
      </p>
      <div className="mt-2 flex items-baseline justify-between">
        <h2 className="font-display text-3xl sm:text-4xl font-bold">
          {meta.title}
        </h2>
        <span
          className={`font-display text-6xl sm:text-7xl font-bold leading-none ${
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

      <div className="mt-6 grid grid-cols-2 gap-3 font-mono text-sm">
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
            <span className="font-mono text-[10px] uppercase tracking-widest text-bone-50/60">
              Best on this track
            </span>
            <span className="font-mono text-sm text-accent">
              {best.score.toLocaleString()}
            </span>
          </div>
          <p className="mt-0.5 font-mono text-[10px] text-bone-50/40">
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
      <span className="text-[10px] uppercase tracking-widest text-bone-50/50">
        {label}
      </span>
      <span className={accent ? "text-accent font-bold" : "text-bone-50"}>
        {value}
      </span>
    </div>
  );
}
