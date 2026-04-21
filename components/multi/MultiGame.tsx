"use client";

/**
 * Multiplayer game view: shared canvas highway + live sidebar scoreboard.
 *
 * Audio sync strategy:
 *   - The server picks a wall-clock `startsAt` and emits
 *     `phase:countdown` once EITHER (a) every connected player has
 *     called `client:ready`, OR (b) the loading deadline elapses with
 *     at least one player ready (the rest late-join). All clients aim
 *     to start their `AudioEngine` at exactly `startsAt` via the
 *     engine's `delay` arg — for late-joiners whose mount happens
 *     AFTER `startsAt` the schedule effect calls `audio.start(0.05,
 *     vol, offset)` with `offset = (now - startsAt) / 1000` so they
 *     slot into the song timeline at the right point.
 *   - During countdown we render a translucent overlay counting down
 *     from ceil((startsAt - now)/1000). Audio is scheduled inside
 *     `start()` using the engine's existing `delay` arg, so even
 *     small browser timer skews are absorbed into the same fixed
 *     lead-in.
 *   - Once `phase` flips to `playing`, the overlay drops and gameplay
 *     is identical to single-player from a feel standpoint. We never
 *     re-sync mid-song — too disruptive — but the wall-clock starting
 *     point keeps everyone within ~50ms of each other for the whole
 *     run. The `audioStartedRef` guard on the schedule effect prevents
 *     a second `audio.start()` on the countdown→playing dependency
 *     change (which would produce an audible click).
 *   - The `AudioEngine` itself lives on `app/multi/[code]/page.tsx`,
 *     not here. The page decodes the buffer during `loading` (in
 *     parallel with the chart download) and passes both the engine
 *     and an `audioReady` flag to this component as props. That
 *     ownership keeps the engine alive across phase swaps and lets
 *     the page-level loading effect drive `client:ready` precisely.
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
import TouchLanes from "@/components/TouchLanes";
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
  loadRenderQuality,
  saveRenderQuality,
  nextRenderQuality,
  loadJudgmentGlyphs,
  saveJudgmentGlyphs,
  onStorageFailure,
  type FpsLock,
  type RenderQuality,
} from "@/lib/game/settings";
import {
  createRenderState,
  crossedComboMilestone,
  DEFAULT_RENDER_OPTIONS,
  drawFrame,
  prewarmRenderer,
  RenderState,
} from "@/lib/game/renderer";
import {
  PlayerStats,
  TOTAL_LANES,
} from "@/lib/game/types";
import {
  MATCH_INTRO_PROMPT_MS,
  MATCH_LEAD_IN_MS,
  MATCH_OVERLAY_MS,
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
  audioEngine,
  audioReady,
}: {
  snapshot: RoomSnapshot;
  scoreboard: ScoreboardEntry[];
  loaded: LoadSongResult | null;
  loadError: string | null;
  actions: RoomActions;
  me: string;
  mode: ChartMode;
  // Owned by the page, NOT by this component. The engine was created
  // and the AudioBuffer was decoded back during the `loading` phase
  // so by the time we mount everything is already in memory and
  // `audio.start()` is just reserving a future timestamp on a
  // pre-warmed graph. See `audioEngineRef` in `app/multi/[code]/page.tsx`
  // for the lifecycle / hoist rationale.
  audioEngine: AudioEngine | null;
  audioReady: boolean;
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
        me={me}
        audioEngine={audioEngine}
        audioReady={audioReady}
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
  me,
  audioEngine,
  audioReady,
}: {
  snapshot: RoomSnapshot;
  loaded: LoadSongResult | null;
  loadError: string | null;
  actions: RoomActions;
  mode: ChartMode;
  me: string;
  audioEngine: AudioEngine | null;
  audioReady: boolean;
}) {
  // Derive host bit off the snapshot rather than threading a separate
  // `isHost` prop. `snapshot.hostId` is mirrored on every snapshot and
  // updates instantly when host promotion happens (e.g. previous host
  // disconnects mid-pause), which means the in-game pause menu can
  // appear under the new host without any extra wiring.
  const isHost = snapshot.hostId === me;
  // ESC-toggle in-match menu. Flips to `true` when ANY player presses
  // ESC mid-match, regardless of host status. The actions exposed on
  // the menu differ by role:
  //
  //   - HOST sees [Resume, Pause, Cancel match]. Opening the menu
  //     does NOT auto-pause for everyone — the host has to click
  //     "Pause" explicitly. That way an accidental ESC tap doesn't
  //     grief 49 other players.
  //   - NON-HOST sees [Resume, Leave]. "Resume" closes the menu;
  //     "Leave" calls `room:leaveMatch` which flips their server-
  //     side `inMatch` to false and routes them back to the Lobby
  //     (where they see a "match in progress" indicator). Leaving
  //     is THIS player only — the rest of the room keeps playing.
  //
  // Forced open whenever the room is paused so every client always
  // has a path to "Resume" (or "Leave", for non-hosts).
  const [matchMenuOpen, setMatchMenuOpen] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /**
   * Most-recently observed CSS pixel size of the canvas. Mirrors the
   * SP `canvasSizeRef` — fed to `drawFrame` so the renderer doesn't
   * have to call `clientWidth` / `clientHeight` (those getters can
   * trigger layout flushes mid-rAF). Updated by the resize effect
   * below; (0, 0) until first observation, in which case `drawFrame`
   * falls back to live getters.
   */
  const canvasSizeRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
  // Mirror the engine prop into a ref so the existing `audioRef.current?.X`
  // call sites (settings effects, schedule effect, render loop) keep
  // working unchanged. The engine itself was created back at the page
  // level during the `loading` phase — we just point a local ref at it
  // here and keep that ref in sync if it ever changes (e.g. a future
  // round in the same room re-uses the same instance, but nothing
  // stops the page from swapping it out).
  const audioRef = useRef<AudioEngine | null>(audioEngine);
  useEffect(() => {
    audioRef.current = audioEngine;
  }, [audioEngine]);
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

  /**
   * `document.fonts.ready` gate for the canvas renderer.
   *
   * Single-player blocks `setPhase("countdown")` on `await
   * document.fonts.ready` so the very first `drawFrame` call is
   * guaranteed to find Space_Grotesk-800 (used for the on-canvas
   * lane letters and the giant combo number) already loaded.
   * Without this gate, multiplayer was relying on the fonts having
   * been requested by ANY parent layout earlier in the navigation
   * — usually true, but on a cold load straight into a `/multi/:code`
   * URL the canvas would render its first frame with the fallback
   * sans-serif and pay a font-swap reflow ~50-200 ms later, smack
   * in the middle of the silent lead-in or even into early gameplay.
   *
   * Default `true` covers SSR + the common warm-cache case (fonts
   * already in memory from a previous page). The mount effect kicks
   * off `document.fonts.ready` and flips the ref back to `true`
   * after the promise resolves; the rAF loop skips `drawFrame`
   * while it's `false` so the canvas just stays the dim base color
   * until the typeface settles.
   */
  const fontsReadyRef = useRef<boolean>(true);

  const [stats, setStats] = useState<PlayerStats | null>(null);
  // Throttled song-progress fraction (0..1) for the rock-meter card's
  // progress bar. Mirrors the single-player Game.tsx pattern — written
  // alongside `setStats` from inside the rAF loop so it ticks at the
  // same ~10Hz cadence (smooth without re-rendering every vblank).
  const [songProgress, setSongProgress] = useState<number>(0);
  // Three-stage countdown overlay state.
  //   - null           → no overlay (silent lead-in only)
  //   - "prompt"       → "Get ready..." banner, no number
  //   - { number: n }  → "Get ready" header + the big "3 / 2 / 1" digit
  // Driven by a single rAF tick that compares Date.now() against the
  // server's `startsAt` so every client paints the same overlay at the
  // same wall-clock instant. See the effect below for the boundaries.
  const [countdownOverlay, setCountdownOverlay] = useState<
    null | { kind: "prompt" } | { kind: "number"; number: number }
  >(null);
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
  // Mirror the latest volume in a ref so the audio-schedule effect can
  // read it without listing `volume` in its deps. Re-triggering that
  // effect on every slider tick would tear down and restart the
  // playing source, which would re-anchor `startedAtCtxTime` and
  // desync the player from the rest of the room. The ref lets us
  // honor the user's volume on the *initial* `audio.start()` fade-in
  // target while leaving the live `setVolume()` call (in the volume
  // effect below) responsible for subsequent slider changes.
  const volumeRef = useRef(volume);
  useEffect(() => {
    volumeRef.current = volume;
  }, [volume]);
  const [metronome, setMetronome] = useState<boolean>(loadMetronome);
  // Per-input feedback SFX — the "Feedback" toggle (hit / miss / release / combo-milestone +
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
  // Render quality preset + judgment glyphs — same persistence keys as
  // single-player so the player's choice transfers between modes.
  // Both are mirrored into `renderOptsRef` below so toggling takes
  // effect on the very next rAF tick (no remount, no stutter).
  const [quality, setQuality] = useState<RenderQuality>(loadRenderQuality);
  const [judgmentGlyphs, setJudgmentGlyphs] = useState<boolean>(loadJudgmentGlyphs);
  // Sticky banner shown the first time storage refuses a write — same
  // pattern as solo. The user can dismiss with one click.
  const [storageBlocked, setStorageBlocked] = useState<boolean>(false);
  useEffect(() => onStorageFailure(() => setStorageBlocked(true)), []);
  // `audioReady` is now sourced from the page-level prop instead of
  // local state. The page resolves it to true the moment the
  // AudioBuffer finishes decoding during the `loading` phase, which
  // means by the time MultiGame mounts `audioReady` is already true
  // for normal flows. The `audioReady` gate on the schedule effect
  // still matters for the reconnect case (where a player drops in
  // mid-game and we re-decode after the fact).

  // Mirror quality + glyphs into the renderer-options ref + persist on
  // change. Same pattern as solo (Game.tsx) so a toggle picks up on
  // the very next frame.
  useEffect(() => {
    renderOptsRef.current.quality = quality;
    saveRenderQuality(quality);
  }, [quality]);
  useEffect(() => {
    renderOptsRef.current.judgmentGlyphs = judgmentGlyphs;
    saveJudgmentGlyphs(judgmentGlyphs);
  }, [judgmentGlyphs]);

  const { theme } = useTheme();
  useEffect(() => {
    renderOptsRef.current.theme = theme;
    renderStateRef.current.cache = undefined;
  }, [theme]);

  // Mount-time font gate. Mirrors the SP `await document.fonts.ready`
  // that runs before countdown — see `fontsReadyRef` doc above. We
  // only flip the ref to `false` if we have a fonts API AND the
  // canvas-critical typeface isn't already loaded; otherwise we
  // never block the renderer.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const fonts = document.fonts;
    if (!fonts || typeof fonts.ready?.then !== "function") return;
    // `fonts.status === "loaded"` means everything currently
    // requested has settled. Combined with the synchronous default
    // of `fontsReadyRef = true` this avoids a needless one-frame
    // skip on warm cache.
    if (fonts.status === "loaded") return;
    fontsReadyRef.current = false;
    let alive = true;
    fonts.ready
      .then(() => {
        if (alive) fontsReadyRef.current = true;
      })
      .catch(() => {
        // If the fonts promise rejects (Firefox edge case during
        // navigation), unblock the renderer anyway — falling back
        // to the system stack for one match is much better than
        // staring at a blank canvas indefinitely.
        if (alive) fontsReadyRef.current = true;
      });
    return () => {
      alive = false;
    };
  }, []);

  // Crisp canvas + DPR resize. Mirrors the cap logic in Game.tsx —
  // coarse-pointer (mobile) clamps DPR to 1.5 instead of 2 so phones
  // with DPR 2.5-3 don't quietly burn 80 % more per-frame fillrate
  // than they need to. Keeps the highway scrolling smooth on phones.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const coarseUA =
        typeof window !== "undefined" && window.matchMedia
          ? window.matchMedia("(pointer: coarse)").matches
          : false;
      const cap = coarseUA ? 1.5 : 2;
      const dpr = Math.min(window.devicePixelRatio || 1, cap);
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.floor(rect.width * dpr);
      canvas.height = Math.floor(rect.height * dpr);
      canvasSizeRef.current.w = rect.width;
      canvasSizeRef.current.h = rect.height;
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Force the renderer to rebuild its size-dependent gradient cache.
      renderStateRef.current.cache = undefined;
      // Pre-warm: build the gradient cache + JIT-compile every hot draw
      // path NOW (the countdown overlay is covering the canvas at this
      // point), so the very first real frame after `audio.start()` doesn't
      // pay the 12–35 ms hitch of cold gradients + cold note/popup paths.
      // That hitch was the root cause of the "tiny stutter when the song
      // begins" players were reporting in multi — without this, the first
      // real-state frame had to build all 4 lane-gate gradients, the
      // highway radial, the milestone vignette AND let V8 promote
      // drawTapNote / drawHoldNote / drawJudgmentText out of the
      // interpreter, all in the same frame the audio kicked in.
      // The helper wipes its synthetic draw via clearRect, so nothing
      // it paints is ever visible to the player. Reads the LIVE
      // renderOptsRef so the cache lands with the right theme baked in.
      if (ctx) {
        prewarmRenderer(ctx, renderOptsRef.current, renderStateRef.current);
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

  /* -------- per-song state reset -------- */
  // Decode is no longer this component's job — the page-level loading
  // effect already filled the AudioEngine's buffer before we even
  // mounted (see `audioEngineRef` in `app/multi/[code]/page.tsx`).
  // What's left for us to do on each new chart is purely the
  // INSTANCE-LOCAL state reset: spin up a fresh GameState for the
  // notes, wipe leftover particles / combo / scheduled-beat cursor
  // from the previous round, and re-arm `audioStartedRef` so the
  // highway gating doesn't trust the audio clock until the schedule
  // effect runs `start()` on the new song.
  useEffect(() => {
    if (!loaded) return;
    audioStartedRef.current = false;
    stateRef.current = new GameState(loaded.notes);
    setStats({ ...stateRef.current.stats });
    lastScheduledBeatRef.current = -1;
    finishedRef.current = false;
    prevComboRef.current = 0;
    lastScoreSentSigRef.current = "";
    const rs = renderStateRef.current;
    rs.particles.length = 0;
    rs.shockwaves.length = 0;
    rs.pendingHits.length = 0;
    rs.laneFlash.fill(0);
    rs.laneAnticipation.fill(0);
    rs.combo = 0;
    rs.milestone = null;
    // Two cursor/event fields the renderer relies on to keep per-frame
    // work proportional to the visible note window. Single-player
    // resets these in `resetRenderState`; here in MP we'd never been
    // resetting them across consecutive matches in the same mount,
    // which left a stale `firstVisibleIdx` pointing into the previous
    // chart's note array. The renderer's bail-on-mismatch was lenient
    // enough not to crash, but the first heavy frame of round 2+ paid
    // a one-time correction cost that registered as micro-stutter.
    rs.firstVisibleIdx = 0;
    rs.recentEvents = [];
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
    // Idempotency guard. The server keeps `startsAt` populated through
    // the entire `playing` phase, so when `songStartedAt` flips from
    // null → number on the countdown→playing transition this effect
    // re-fires. Without this guard we'd hit `audio.start()` a SECOND
    // time for the same round — and since `start()` always begins
    // with `stop()`, that produces a tiny stop-and-restart click
    // exactly when the song should be settling into its first beat.
    // `audioStartedRef` is reset to false in the per-song state-reset
    // effect above (deps: `[loaded]`), so a fresh round still arms
    // properly. A reconnect-into-play that swaps the loaded chart
    // also resets it. Lobby return clears `loaded`, then the next
    // round refills it.
    if (audioStartedRef.current) return;
    // Don't start audio while the host has the match paused. A late
    // joiner whose download finished mid-pause hits this branch:
    // we wait for the host to resume (which clears `pausedAt` and
    // shifts `songStartedAt` forward by the pause duration), then
    // this effect re-fires and computes the right seek offset
    // against the post-pause baseline.
    if (snapshot.pausedAt !== null) return;
    const startsAt = snapshot.startsAt ?? snapshot.songStartedAt;
    if (!startsAt) return;
    const delayMs = startsAt - Date.now();
    const audio = audioRef.current;
    let cancelled = false;
    const schedule = () => {
      if (cancelled) return;
      try {
        // Use the user's saved volume for the initial fade-in target
        // (read via ref so this effect doesn't restart on slider moves
        // — see `volumeRef` declaration). Without this, every multi
        // start used to ramp to a hardcoded 0.85 and then snap up to
        // the user's actual volume on the next render via
        // `setVolume()`, which produced a small audible step at the
        // top of every song.
        const startVol = volumeRef.current;
        if (delayMs >= 0) {
          // Future start — normal countdown lead-in.
          audio.start(delayMs / 1000, startVol);
        } else {
          // Past start — seek to the right offset so we sound in time.
          // We give ourselves a tiny 50ms head-start so the fade-in doesn't
          // cut into the very first frame after mount.
          const offset = -delayMs / 1000;
          audio.start(0.05, startVol, offset);
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
  }, [audioReady, loaded, snapshot.startsAt, snapshot.songStartedAt, snapshot.pausedAt]);

  // Pause / resume the AudioContext in lockstep with the room's
  // `pausedAt` flag. Only fires AFTER the schedule effect has
  // anchored `audioStartedRef.current = true`; before that, there's
  // no live source to suspend (the AudioBuffer is decoded but no
  // source has been started yet — `audio.pause()` would just be a
  // no-op `ctx.suspend()` that prevents the upcoming `audio.start()`
  // from running cleanly). Pause/resume on AudioContext freezes
  // `ctx.currentTime`, so each client's `songTime()` (and therefore
  // the rAF loop's miss-expiry, score-signature, and end-of-song
  // checks) freeze automatically without any extra work.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!audioStartedRef.current) return;
    if (snapshot.pausedAt !== null) {
      void audio.pause();
    } else {
      void audio.resume();
    }
  }, [snapshot.pausedAt]);

  // Mirror `pausedAt` into a ref so the input handlers (which read it
  // synchronously on every keypress) don't have to be a dep of their
  // installation effect. Same pattern as `phaseRef` — keeps the
  // listener bound across the entire match instead of rebinding on
  // every snapshot tick.
  const pausedRef = useRef(snapshot.pausedAt !== null);
  useEffect(() => {
    pausedRef.current = snapshot.pausedAt !== null;
  }, [snapshot.pausedAt]);

  // Countdown overlay tick.
  //
  // The server's `startsAt` is when audio actually fires. From that
  // anchor we work backwards to derive the overlay timeline so every
  // client paints the same thing at the same wall-clock instant —
  // server, audio, and overlay all stay phase-locked even if a player
  // joined slightly late. Stages (working forwards from the moment
  // `phase:countdown` flips):
  //
  //   ["Get ready..."]   t < numbersStart                → kind:"prompt"
  //   ["3 / 2 / 1"]      t in numbersWindow              → kind:"number"
  //   [silent lead-in]   t ≥ numbersEnd                  → null
  //   [audio starts]     t ≥ startsAt
  //
  //   numbersEnd    = startsAt - LEAD_IN_MS              (3,2,1 disappears)
  //   numbersStart  = numbersEnd - OVERLAY_MS            (3,2,1 begins)
  //
  // The "Get ready..." prompt starts immediately when we enter the
  // countdown phase (no empty pre-roll any more) — there's nothing
  // for the player to do during a silent runway and the prompt itself
  // already reads as "match is starting". The rAF loop only pushes
  // state when the visible stage actually changes, so cost is one
  // comparison per vblank.
  useEffect(() => {
    if (snapshot.phase !== "countdown" || !snapshot.startsAt) {
      setCountdownOverlay(null);
      return;
    }
    const startsAt = snapshot.startsAt;
    const numbersEnd = startsAt - MATCH_LEAD_IN_MS;
    const numbersStart = numbersEnd - MATCH_OVERLAY_MS;

    let lastKey = "";
    const tick = () => {
      const now = Date.now();
      let next:
        | null
        | { kind: "prompt" }
        | { kind: "number"; number: number };
      if (now < numbersStart) {
        next = { kind: "prompt" };
      } else if (now < numbersEnd) {
        const remaining = (numbersEnd - now) / 1000;
        next = { kind: "number", number: Math.max(1, Math.ceil(remaining)) };
      } else {
        next = null;
      }
      // Only push state when the visible overlay actually changes —
      // avoids a setState per vblank and the React work that follows.
      const key =
        next === null
          ? "null"
          : next.kind === "prompt"
            ? "prompt"
            : `n${next.number}`;
      if (key !== lastKey) {
        lastKey = key;
        setCountdownOverlay(next);
      }
      // Stop ticking once we're past the numbers (silent lead-in is
      // a constant null state until phase flips to "playing"); saves
      // ~120 useless ticks over the 2 s lead-in.
      if (now >= numbersEnd) return;
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

  // `eventTimestamp` is the `performance.now()` moment from the
  // KeyboardEvent / PointerEvent that caused the press — passed through
  // to `audio.inputSongTime()` so judgments use the audio clock at the
  // actual key-down moment, not "audio clock when the React handler
  // happened to run". See audio.ts and Game.tsx for the full rationale.
  const pressLane = useCallback((lane: number, eventTimestamp?: number) => {
    if (phaseRef.current === "results") return;
    heldRef.current[lane] = true;
    if (phaseRef.current !== "playing") return;
    // Drop lane input while the room is paused. The audio clock is
    // frozen on every client, so even an honest mash would miss
    // judge against a stale `songTime` (and a hostile client could
    // register pre-positioned hits). Held-state stays accurate
    // because we still flip `heldRef[lane] = true` above.
    if (pausedRef.current) return;
    const audio = audioRef.current;
    const state = stateRef.current;
    if (!audio || !state) return;
    const songTime = audio.inputSongTime(eventTimestamp);
    const evt = state.hit(lane, songTime);
    if (evt) {
      renderStateRef.current.laneFlash[lane] = 1;
      renderStateRef.current.pendingHits.push({ lane, judgment: evt.judgment });
      audio.playHit(lane, evt.judgment);
    } else {
      renderStateRef.current.laneFlash[lane] = 0.45;
      audio.playEmptyPress();
    }
  }, []);

  const releaseLane = useCallback((lane: number, eventTimestamp?: number) => {
    if (phaseRef.current === "results") return;
    heldRef.current[lane] = false;
    if (phaseRef.current !== "playing") return;
    // Mirror `pressLane`: while paused we still clear the held state
    // (so the player doesn't auto-fire on resume), but we don't run
    // the engine's tail-judgment — the audio clock is frozen so the
    // judgment would land at a stale time.
    if (pausedRef.current) return;
    const audio = audioRef.current;
    const state = stateRef.current;
    if (!audio || !state) return;
    const tailEvt = state.release(lane, audio.inputSongTime(eventTimestamp));
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

  // Global keyboard install — RUNS ONCE for the lifetime of the
  // component. Same fix as single-player Game.tsx: the previous
  // dep array `[snapshot.phase, snapshot.pausedAt, pressLane,
  // releaseLane]` caused the listeners to tear down + reattach at
  // the server-driven `countdown → playing` boundary, ~2 s before
  // the song became audible — a documented contributor to the
  // first-second-of-the-match stutter. Reading phase + pausedAt
  // from `phaseRef` / `pausedRef` keeps listener identity stable
  // for the entire `lobby → countdown → playing → results` arc.
  // pressLane / releaseLane are useCallback'd with empty deps and
  // read entirely off refs themselves, safe to capture once.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const phase = phaseRef.current;
      if (phase !== "playing" && phase !== "countdown") return;
      // Skip when the user is typing in a form field (future chat, name
      // change, etc). Same guard as single-player Game.tsx.
      if (isEditableTarget(e.target)) return;
      // ESC → toggle the in-match menu for any player. Unlike
      // single-player (where ESC is a hard pause), this is a
      // confirmation surface: the menu just OPENS — opening it
      // does not pause the song or change game state. The host
      // can then click "Pause" / "Cancel match"; non-hosts can
      // click "Leave". That way an accidental ESC press is purely
      // a UI artefact for everyone instead of griefing the
      // session. When the room is already paused we leave the
      // menu open via the render-side `forceOpen` branch, so ESC
      // pressed while paused is a no-op rather than a confusing
      // close that would strand the player without a Resume button.
      if (e.code === "Escape") {
        if (pausedRef.current) return;
        e.preventDefault();
        setMatchMenuOpen((open) => !open);
        return;
      }
      // M = metronome, N = feedback SFX. Both are local-only
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
      // Drop focus from any non-text control (volume slider, settings
      // checkbox, etc.) the moment lane input resumes — keeps the
      // focus ring from following the player around and prevents
      // stuck arrow-key auto-repeat from secretly nudging the slider.
      // See Game.tsx for the full rationale.
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== document.body) {
        active.blur();
      }
      // Pass the event's `performance.now()` timestamp so the audio
      // engine can back the songTime up to the actual key-down moment,
      // cancelling out handler-dispatch lag (see audio.ts inputSongTime).
      pressLane(lane, e.timeStamp);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const phase = phaseRef.current;
      if (phase !== "playing" && phase !== "countdown") return;
      // No `isEditableTarget` short-circuit: chat / name input is a
      // realistic mid-song interaction, and if the player held a lane
      // key, focused chat (keydown still in flight or already past),
      // and then released, the keyup target IS the input. Skipping
      // would strand the hold note's tail and leave `heldRef` set
      // until they retap that lane — confusing in the middle of a
      // song. Releasing is always safe (no-op if not held). Same
      // rationale as Game.tsx onKeyUp.
      const lane = KEY_TO_LANE[e.code];
      if (lane === undefined) return;
      releaseLane(lane, e.timeStamp);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
    // Empty deps ON PURPOSE — see leading comment. Phase / pausedAt
    // are read from refs; pressLane/releaseLane are mount-stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-close the in-match menu when we leave the playing phase
  // (host clicked "Cancel match" → room flips to lobby; the safety
  // timer transitioned to results; non-host's `room:leaveMatch`
  // routed them out of MultiGame entirely — though in that case
  // this component has unmounted anyway). Without this, the menu
  // state would persist and pop back open the next time the player
  // enters a match.
  useEffect(() => {
    if (snapshot.phase !== "playing" && snapshot.phase !== "countdown") {
      setMatchMenuOpen(false);
    }
  }, [snapshot.phase]);

  /* -------- pointer-capability detection ---------------------------------
     `touchOnly` (coarse + no fine) governs hint copy ("tap" vs keyboard).
     `coarsePointer` (coarse, regardless of fine) governs whether to render
     the on-screen <TouchLanes> overlay so a hybrid touchscreen laptop can
     use BOTH fingers and keyboard. See Game.tsx for the same split. */
  const [touchOnly, setTouchOnly] = useState(false);
  const [coarsePointer, setCoarsePointer] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    const noFine = !window.matchMedia("(any-pointer: fine)").matches;
    setTouchOnly(coarse && noFine);
    setCoarsePointer(coarse);
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
    // Level-edge tracker for the dedicated combo-break SFX. Same
    // pattern as `lastMissCount`: the engine increments
    // `state.stats.comboBreaks` whenever a miss zeros a combo
    // ≥ COMBO_BREAK_THRESHOLD, and we observe the counter as a
    // monotonic edge so a rapid miss-then-hit can't lose the trigger.
    let lastComboBreakCount = stateRef.current?.stats.comboBreaks ?? 0;
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
        // Per-miss SFX is silent — but a subtle Guitar-Hero-style
        // song distort fires on every miss (45 % dip + light lowpass
        // + 30-cent pitch wobble, ~220 ms). The combo-break watcher
        // runs immediately after with its own deeper duck; `duckSong`
        // cancels + re-schedules its ramps each call so the bigger
        // duck wins on combo-break frames.
        const misses = state.stats.hits.miss;
        if (misses > lastMissCount) {
          audio?.playMissDistort();
          lastMissCount = misses;
        }
        const breaks = state.stats.comboBreaks;
        if (breaks > lastComboBreakCount) {
          audio?.playComboBreak();
          lastComboBreakCount = breaks;
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

        // End-of-song detection. `state.notes.every(...)` used to walk
        // the entire chart EVERY frame in the trailing 1.5s window —
        // O(n) per frame, measurable on dense charts in a 50-player
        // room. Replaced with `notesPlayed >= totalNotes`, which the
        // engine maintains in O(1) (holds add 2 to totalNotes for
        // head + tail, and the judgment helpers each increment
        // notesPlayed once). The 1.5s grace window after `lastEnd`
        // is preserved so players see their final judgment popup
        // before the canvas hands off to the results screen.
        const lastNote = state.notes[state.notes.length - 1];
        const lastEnd = lastNote
          ? isHold(lastNote)
            ? (lastNote.endT as number)
            : lastNote.t
          : 0;
        const allJudged =
          lastNote &&
          songTime > lastEnd + 1.5 &&
          state.stats.totalNotes > 0 &&
          state.stats.notesPlayed >= state.stats.totalNotes;
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
      // Skip painting until canvas-critical fonts have settled.
      // See `fontsReadyRef` for the full rationale — this is the
      // multiplayer parity for SP's pre-countdown `await
      // document.fonts.ready`. Per-frame state still steps (the
      // `rs.laneFlash` decay above continues), only the visible
      // pixel commit is deferred. In practice the gate is open
      // within tens of milliseconds of mount so the player never
      // notices a blank frame.
      if (fontsReadyRef.current) {
        drawFrame(
          ctx,
          drawState,
          songTime,
          dt,
          renderOptsRef.current,
          rs,
          canvasSizeRef.current.w,
          canvasSizeRef.current.h,
        );
      }

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

  // No engine-stop on unmount: lifecycle is OWNED by the page now
  // (see `audioEngineRef` in `app/multi/[code]/page.tsx`). The page
  // calls `engine.stop()` when the room flips back to `lobby` and
  // again on full page unmount, which covers every legitimate way
  // a player can exit the canvas. Stopping here too would race with
  // the page's own `stop()` and, more importantly, would kill the
  // engine when transitioning to the `results` screen — the engine
  // is supposed to keep its decoded buffer alive across that screen
  // so a "play again" round in the same room reuses the same buffer
  // (the loadFromBytes dedup check in audio.ts catches this).

  return (
    <div className="absolute inset-0">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 block h-full w-full"
      />

      {/* Discreet "settings won't persist" banner. Identical to the
          solo flow's banner — surfaces the first time storage refuses
          a write so the player understands why their toggles reset
          on reload. Anchored top-center so it doesn't compete with
          the HUD strip on either side. Dismissible. */}
      {storageBlocked && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-30 flex justify-center px-3 pt-3">
          <div className="pointer-events-auto w-full max-w-md rounded-2xl border border-bone-50/30 bg-bone-900/90 px-4 py-3 backdrop-blur">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="font-mono text-[0.6rem] uppercase tracking-[0.4em] text-bone-50/70">
                  settings won&apos;t persist
                </p>
                <p className="mt-1 font-mono text-[0.7rem] text-bone-50/70">
                  Browser refused a save (private browsing, full storage, or an extension). Toggles still work this session.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setStorageBlocked(false)}
                className="shrink-0 rounded-md border border-bone-50/30 px-2.5 py-1 font-mono text-[0.6rem] uppercase tracking-widest text-bone-50/70 transition hover:border-bone-50/60 hover:text-bone-50"
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}

      {stats && (
        // Same combined SCORE+COMBO panel as single-player, with the rock
        // meter card stacked directly underneath. The wrapping column is
        // `w-fit` so it shrinks to the wider of its two children (the
        // performance panel), and the rock meter then uses `w-full` to
        // match it pixel-for-pixel — that's what the user sees as "the
        // rock meter is as wide as the score container above".
        // No HUD-level pause button: multiplayer pause is host-only
        // and reached through the ESC menu (`MatchMenuOverlay`),
        // since freezing 50 other players is a deliberate decision
        // not a settings toggle. Metronome + volume + fps stay here
        // so the player keeps the same audio controls they have in
        // solo.
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
          {/* Locked-down width so the left column always matches the
              right scoreboard's card width — the two side panels read
              as a balanced pair, and neither ever creeps onto the
              fret/highway. The values track the single-player HUD
              (`Game.tsx`) exactly so solo and multi feel like the
              same UI at every breakpoint. */}
          <div className="flex w-[156px] flex-col gap-3 sm:w-[220px] sm:gap-5 lg:w-[244px] xl:w-[268px]">
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
              quality={quality}
              onCycleQuality={() => setQuality((cur) => nextRenderQuality(cur))}
              judgmentGlyphs={judgmentGlyphs}
              onToggleGlyphs={() => setJudgmentGlyphs((g) => !g)}
              songTitle={loaded?.meta.title ?? snapshot.selectedSong?.title ?? null}
              songArtist={loaded?.meta.artist ?? snapshot.selectedSong?.artist ?? null}
              songDuration={loaded?.meta.duration ?? null}
              songProgress={songProgress}
            />
          </div>
        </div>
      )}

      {/* Pause / in-match-menu overlay.
       *
       * Two render-states sit under one component to keep the keyboard
       * focus + visual style consistent:
       *
       *   1. Room paused (`snapshot.pausedAt !== null`) — every player
       *      sees the dimmed overlay. Host gets [Resume, Cancel match]
       *      buttons; non-hosts get [Leave] (and a "waiting for host"
       *      subtitle since they can't resume the room themselves).
       *
       *   2. Menu open while still playing (`matchMenuOpen` and
       *      `pausedAt === null`) — confirmation surface for any
       *      player. The match keeps running underneath. Host actions
       *      are [Resume, Pause, Cancel match]; non-host actions are
       *      [Resume, Leave]. "Leave" calls `room:leaveMatch` which
       *      flips this client's `inMatch` to false and routes them
       *      to the Lobby on the next snapshot.
       *
       * Both branches are gated on phase ∈ {countdown, playing} so
       * the menu doesn't ghost over the lobby/results screens. */}
      {(snapshot.phase === "playing" || snapshot.phase === "countdown") &&
        (snapshot.pausedAt !== null || matchMenuOpen) && (
          <MatchMenuOverlay
            isHost={isHost}
            paused={snapshot.pausedAt !== null}
            onResume={() => {
              if (snapshot.pausedAt !== null && isHost) {
                actions.resumeMatch();
              }
              setMatchMenuOpen(false);
            }}
            onPause={() => actions.pauseMatch()}
            onCancel={() => {
              actions.cancelMatch();
              setMatchMenuOpen(false);
            }}
            onLeave={() => {
              actions.leaveMatch();
              setMatchMenuOpen(false);
            }}
          />
        )}

      {countdownOverlay !== null && (
        <Overlay translucent>
          <div className="text-center">
            <p className="font-mono text-[0.79rem] uppercase tracking-[0.4em] text-accent">
              {countdownOverlay.kind === "prompt"
                ? "Get ready..."
                : "Get ready"}
            </p>
            {countdownOverlay.kind === "number" && (
              <p className="mt-2 font-display text-[clamp(6.3rem,18.9vw,12.6rem)] font-bold leading-none drop-shadow-[0_0_30px_rgba(61,169,255,0.6)]">
                {countdownOverlay.number}
              </p>
            )}
            <p className="mt-2 font-mono text-[0.79rem] uppercase tracking-widest text-bone-50/60">
              {touchOnly ? "tap the lanes" : "D F J K · or ← ↓ ↑ →"}
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

      {/* Touch / click lane buttons — shared component with solo. Shown
          whenever a coarse pointer is available (mobile, tablet, hybrid
          touchscreen laptop), only during countdown/playing so the buttons
          don't intercept clicks on the lobby / loading / results UI. */}
      {coarsePointer &&
        (snapshot.phase === "countdown" || snapshot.phase === "playing") && (
          <TouchLanes onPress={pressLane} onRelease={releaseLane} />
        )}
    </div>
  );
}

// On-screen lane buttons live in `components/TouchLanes.tsx` (shared
// with single-player). Single source of truth for pointer capture,
// multi-touch lane mapping, and the React-driven highlight.

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
      {/* Padding and inner gap mirror the HUD cards (`px-2.5 py-2.5
          sm:px-3.5 sm:py-3.5`, `gap-2 sm:gap-2.5`) so the live
          scoreboard reads as the same UI vocabulary as the score /
          settings cards opposite it. The list rows also use the same
          `px-2.5 py-2` rhythm as the settings tiles for consistent
          visual density. */}
      <aside
        className="brut-card pointer-events-auto absolute right-3 top-3 flex max-h-[calc(100%-1.5rem)] w-[156px] max-w-[40vw] flex-col gap-2 px-2.5 py-2.5 sm:right-3 sm:top-5 sm:max-h-[calc(100%-2.5rem)] sm:w-[220px] sm:gap-2.5 sm:px-3.5 sm:py-3.5 lg:right-5 lg:w-[244px] xl:w-[268px]"
      >
      <div className="flex items-baseline justify-between gap-2">
        <p className="font-mono text-[10.2px] uppercase tracking-[0.4em] text-accent">
          ░ Live
        </p>
        <span className="font-mono text-[9.2px] uppercase tracking-widest text-bone-50/40 sm:text-[10.2px]">
          {entries.filter((e) => e.online).length} online
        </span>
      </div>
      {/* Same cap as the lobby roster (~6-7 rows) so the live scoreboard
          stays compact even on tall viewports — keeps the panel from
          stretching down to the gameplay canvas ceiling on a 4K monitor
          when a 50-player room is full. The brutalist scrollbar (wired
          globally in globals.css) takes over once the cap is hit. */}
      <ol className="max-h-72 flex-1 space-y-1.5 overflow-y-auto pr-1">
        {entries.map((e, i) => {
          const isMe = e.id === me;
          return (
            <li
              key={e.id}
              className={`flex items-center gap-2 border-2 px-2.5 py-2 font-mono transition-colors ${
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
    // exactly so both modes share visual vocabulary; the only
    // difference here is there's no per-player pause button — pause
    // is host-only and lives in the ESC menu so the host explicitly
    // owns "freeze the room". The rock meter bar is bumped up
    // (`h-3.5 sm:h-[1.05rem]`) so it reads as the headline status
    // indicator of the card instead of a thin afterthought.
    // Card layout / spacing is a 1:1 mirror of the single-player
    // PerformancePanel (`Game.tsx`). The vertical separator between
    // SCORE and COMBO and the horizontal rule above the rock-meter
    // group were removed because the parent card's `gap-*` already
    // creates visual separation — same vocabulary as solo. The combo
    // column also drops `items-center justify-center` so it aligns
    // top-left like the score column, with the same `mt-1.5` rhythm
    // and identical font sizes (color is the only diff).
    <div className="brut-card-accent flex w-full flex-col gap-2 px-2.5 py-2 sm:gap-2.5 sm:px-3 sm:py-3 xl:gap-3 xl:px-4">
      <div className="flex items-stretch gap-2 sm:gap-3 xl:gap-4">
        <div className="min-w-[80px] sm:min-w-[116px] xl:min-w-[132px]">
          <p className="font-mono text-[9.2px] uppercase tracking-widest text-bone-50/60 sm:text-[10.2px]">
            Score
          </p>
          <p className="mt-1.5 font-display text-[1.27rem] font-bold leading-none sm:text-[1.91rem]">
            {stats.score.toLocaleString()}
          </p>
          <p className="mt-1.5 font-mono text-[9.2px] text-bone-50/60 sm:text-[10.2px]">
            {accuracy.toFixed(1)}% · {stats.notesPlayed}/{stats.totalNotes}
          </p>
        </div>
        <div className="min-w-[48px] sm:min-w-[68px] xl:min-w-[80px]">
          <p className="font-mono text-[9.2px] uppercase tracking-widest text-bone-50/60 sm:text-[10.2px]">
            Combo
          </p>
          <p
            className={`mt-1.5 font-display text-[1.27rem] font-bold leading-none tabular-nums sm:text-[1.91rem] ${
              stats.combo > 0 ? "text-accent" : "text-bone-50/40"
            }`}
          >
            {stats.combo}
          </p>
          <p className="mt-1.5 font-mono text-[9.2px] text-accent sm:text-[10.2px]">
            ×{stats.multiplier}
          </p>
        </div>
      </div>
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
          className="inline-flex shrink-0 items-center border border-accent/60 px-2 py-0.5 font-mono text-[8.2px] uppercase tracking-widest text-accent sm:text-[9.2px]"
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
 * perf knobs (Metronome, Feedback, FPS lock, Volume), all styled
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
  quality,
  onCycleQuality,
  judgmentGlyphs,
  onToggleGlyphs,
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
  /** Feedback SFX toggle (hit / miss / release / milestone). */
  sfx: boolean;
  onToggleSfx: () => void;
  fps: number;
  fpsLock: FpsLock;
  onCycleFpsLock: () => void;
  /** Render quality preset — same control as the in-match HUD in
   *  single-player. Persisted across sessions and shared between
   *  modes. */
  quality: RenderQuality;
  onCycleQuality: () => void;
  /** Color-blind helper toggle — adds glyphs to judgment popups. */
  judgmentGlyphs: boolean;
  onToggleGlyphs: () => void;
  songTitle: string | null;
  songArtist: string | null;
  /** Track duration in seconds, or null until the chart is loaded. */
  songDuration: number | null;
  /** Fractional song progress 0..1, throttled in the rAF loop. */
  songProgress: number;
}) {
  return (
    // Card outer padding/gap mirrors the single-player settings card
    // (`px-2.5 py-2.5 sm:px-3.5 sm:py-3.5`, `gap-2 sm:gap-2.5`) so the
    // two HUDs read as the same UI. The previous tighter values made
    // the multi card look more cramped than its solo twin (caption→
    // title→artist→progress all glued together), even though the
    // contents were identical.
    <div className="brut-card flex w-full flex-col gap-2 px-2.5 py-2.5 sm:gap-2.5 sm:px-3.5 sm:py-3.5">
      {/* "Now playing" strip — see Game.tsx HUD for the rationale.
          In multi we prefer the locally-loaded chart's metadata when
          available, falling back to the room snapshot's `selectedSong`
          so the strip is populated even before the audio buffer is
          ready. Spacing inside the strip (caption / title / artist /
          progress) carries explicit `mt-*` values that match the
          single-player HUD beat-for-beat — that beat is the source of
          visual coherence between the two modes. The bottom border /
          padding on the wrapper was removed because the parent card's
          `gap-*` already separates this strip from the settings tiles
          below (same as single). */}
      {songTitle && (
        <div className="flex min-w-0 flex-col">
          <p className="truncate font-mono text-[8.2px] uppercase tracking-widest text-bone-50/45 sm:text-[9.2px]">
            ♪ Now playing
          </p>
          {/* Two-line clamp + ellipsis (matches the single-player
              HUD). Full "Song / Artist" text is on hover via the
              tooltip — same wording as the landing-page card so the
              user learns one pattern. `pointer-events-auto` is
              required because the HUD wrapper is `pointer-events-
              none` (so it doesn't trap clicks over the highway). */}
          <p
            className="pointer-events-auto mt-2 line-clamp-2 break-words font-mono text-[10.2px] font-bold leading-tight text-bone-50/90 sm:text-[11.2px]"
            data-tooltip={`Song: ${songTitle}${songArtist ? `\nArtist: ${songArtist}` : ""}`}
          >
            {songTitle}
          </p>
          {songArtist && (
            <p
              className="pointer-events-auto mt-1 line-clamp-2 break-words font-mono text-[9.2px] leading-tight text-bone-50/50 sm:text-[10.2px]"
              data-tooltip={`Song: ${songTitle}\nArtist: ${songArtist}`}
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
            <div className="mt-2.5 flex items-center gap-2">
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
        className="pointer-events-auto flex cursor-pointer items-center justify-between gap-2 border border-bone-50/30 bg-ink-900/40 px-2.5 py-2"
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
        className="pointer-events-auto flex cursor-pointer items-center justify-between gap-2 border border-bone-50/30 bg-ink-900/40 px-2.5 py-2"
        data-tooltip="Toggle feedback (N)"
      >
        <span className="font-mono text-[9.2px] uppercase tracking-widest text-bone-50/70 sm:text-[10.2px]">
          Feedback
        </span>
        <input
          type="checkbox"
          checked={sfx}
          onChange={onToggleSfx}
          className="h-[14px] w-[14px] cursor-pointer accent-accent"
          aria-label="Toggle input sound effects"
          aria-keyshortcuts="N"
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
        className="pointer-events-auto hidden cursor-pointer items-center justify-between gap-2 border border-bone-50/30 bg-ink-900/40 px-2.5 py-2 text-left sm:flex"
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
      {/* Quality preset tile — see Game.tsx HUD for the full design
          rationale. Same affordance as the FPS-lock tile above:
          whole-tile click target, left caption + readout, right
          chip flips to accent when not on the default value.
          The HIGH ↔ PERF toggle is read on the very next rAF tick
          via `renderOptsRef.current.quality`, so a player who
          notices a frame-drop mid-match can switch live and feel
          the change immediately without leaving the room. */}
      <button
        type="button"
        onClick={onCycleQuality}
        className="pointer-events-auto hidden cursor-pointer items-center justify-between gap-2 border border-bone-50/30 bg-ink-900/40 px-2.5 py-2 text-left sm:flex"
        data-tooltip={
          quality === "high"
            ? "Quality: HIGH — full visual effects. Click to switch to PERFORMANCE if you see frame-drops."
            : "Quality: PERFORMANCE — visual effects disabled for steady frame rate. Click to switch back to HIGH."
        }
        aria-label="Cycle render quality preset"
      >
        <span className="flex flex-col">
          <span className="font-mono text-[9.2px] uppercase tracking-widest text-bone-50/70 sm:text-[10.2px]">
            Quality
          </span>
          <span className="font-mono text-[9.2px] tracking-widest text-bone-50/40">
            {quality === "high" ? "full vfx" : "no vfx"}
          </span>
        </span>
        <span
          aria-hidden
          className="font-mono text-[9.2px] uppercase tracking-widest tabular-nums text-accent"
        >
          {quality === "high" ? "HIGH" : "PERF"}
        </span>
      </button>
      {/* Color-blind glyphs tile — accessibility opt-in. Off by
          default; on, judgment popups gain a small ASCII glyph
          prefix (`* + = x`) so judgments are still
          distinguishable for players who can't lean on the
          blue/green/yellow/red color cue. */}
      <label
        className="pointer-events-auto hidden cursor-pointer items-center justify-between gap-2 border border-bone-50/30 bg-ink-900/40 px-2.5 py-2 sm:flex"
        data-tooltip="Add a glyph (* + = x) before each judgment popup so judgments are distinguishable without color."
      >
        <span className="font-mono text-[9.2px] uppercase tracking-widest text-bone-50/70 sm:text-[10.2px]">
          Glyphs
        </span>
        <input
          type="checkbox"
          checked={judgmentGlyphs}
          onChange={onToggleGlyphs}
          className="h-[14px] w-[14px] cursor-pointer accent-accent"
          aria-label="Toggle judgment glyphs (color-blind helper)"
        />
      </label>
      <div className="flex items-center gap-2 border border-bone-50/30 bg-ink-900/40 px-2.5 py-2">
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
/**
 * In-match menu + room-wide pause card.
 *
 * One component, four button-set permutations driven by `paused` and
 * `isHost`:
 *
 *   - HOST · paused      → [Resume, Cancel match]. Resume re-arms
 *     the audio for the whole room; cancel ends the match for
 *     everyone.
 *   - HOST · not paused  → [Resume, Pause, Cancel match]. The
 *     match keeps running underneath the menu — Resume just closes
 *     the menu without changing state; Pause freezes everyone;
 *     Cancel bounces everyone to the lobby.
 *   - NON-HOST · paused  → [Leave]. The host owns Resume; non-hosts
 *     can leave the match at any time. A "waiting for host" note
 *     reassures the player that the freeze is intentional.
 *   - NON-HOST · not paused → [Resume, Leave]. Resume closes the
 *     menu (game keeps running underneath); Leave fires
 *     `room:leaveMatch` and routes them to the Lobby on the next
 *     snapshot.
 *
 * Buttons fan out to the props injected by `CanvasPane`, which call
 * the corresponding `actions.*()` socket emits. The server handles
 * all the idempotency + phase guards, so a stale double-click is safe.
 */
function MatchMenuOverlay({
  isHost,
  paused,
  onResume,
  onPause,
  onCancel,
  onLeave,
}: {
  isHost: boolean;
  paused: boolean;
  onResume: () => void;
  onPause: () => void;
  onCancel: () => void;
  onLeave: () => void;
}) {
  const headline = paused ? "Paused" : "Match in progress";
  const subheading = paused
    ? isHost
      ? "Audio is suspended for everyone — resume when you're ready"
      : "Host paused the match — hang tight, or leave to sit it out in the lobby"
    : isHost
      ? "The song is still playing — choose how to proceed"
      : "The song is still playing — resume to keep playing or leave to sit it out";
  // Lighter dim while the song is still going (so the player can still
  // see what they're missing); full dim when paused (everyone is
  // staring at the same frozen frame, no point pretending).
  return (
    <Overlay translucent={!paused}>
      <div className="brut-card w-full max-w-md p-7 sm:p-9 text-center">
        <p className="font-mono text-[10.5px] uppercase tracking-[0.4em] text-accent">
          {paused ? "Multiplayer · Paused" : "Multiplayer · Menu"}
        </p>
        <h2 className="mt-3 font-display text-[3.15rem] font-bold leading-none">
          {paused ? "❚❚" : headline}
        </h2>
        {paused && (
          <p className="mt-2 font-mono text-[0.95rem] uppercase tracking-widest text-bone-50/80">
            {headline}
          </p>
        )}
        <p className="mt-4 font-mono text-[0.79rem] uppercase tracking-widest text-bone-50/60">
          {subheading}
        </p>

        {isHost ? (
          // Host actions: [Resume, (Pause when not paused), Cancel match].
          // Grid column count tracks the visible button count so they
          // remain evenly spaced.
          <div className={`mt-7 grid gap-3 ${paused ? "grid-cols-2" : "grid-cols-3"}`}>
            <button
              onClick={onResume}
              className="brut-btn-accent px-3 py-3"
              data-tooltip={
                paused
                  ? "Resume the match for everyone"
                  : "Close menu and keep playing"
              }
            >
              ▶ Resume
            </button>
            {!paused && (
              <button
                onClick={onPause}
                className="brut-btn px-3 py-3"
                data-tooltip="Pause the match for every player"
              >
                ❚❚ Pause
              </button>
            )}
            <button
              onClick={onCancel}
              className="brut-btn px-3 py-3"
              data-tooltip="End the match early — everyone returns to the lobby (no standings recorded)"
            >
              ✕ Cancel match
            </button>
          </div>
        ) : (
          // Non-host actions: [Resume (when not paused), Leave]. We
          // hide Resume during a pause because there's nothing for
          // the non-host to resume — they'd just be closing the
          // overlay over a frozen game with no input registering.
          // Leaving is the only sensible action while paused.
          <div className={`mt-7 grid gap-3 ${paused ? "grid-cols-1" : "grid-cols-2"}`}>
            {!paused && (
              <button
                onClick={onResume}
                className="brut-btn-accent px-3 py-3"
                data-tooltip="Close menu and keep playing"
              >
                ▶ Resume
              </button>
            )}
            <button
              onClick={onLeave}
              className="brut-btn px-3 py-3"
              data-tooltip="Leave this match and watch from the lobby — the rest of the room keeps playing"
            >
              ← Leave
            </button>
          </div>
        )}

        {!isHost && paused && (
          // Subtle reminder that the host is the one who controls the
          // resume — keeps non-hosts from refreshing the page or
          // assuming the room hung.
          <div className="mt-4 flex items-center justify-center gap-3">
            <Spinner />
            <p className="font-mono text-[0.79rem] uppercase tracking-widest text-bone-50/70">
              waiting for host…
            </p>
          </div>
        )}

        <p className="mt-4 font-mono text-[10.5px] uppercase tracking-widest text-bone-50/40">
          {isHost
            ? paused
              ? "Resume picks up exactly where the song left off"
              : "ESC = close menu · cancel doesn't save the run"
            : "Leaving keeps you in the room — you'll be in the next round automatically"}
        </p>
      </div>
    </Overlay>
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

/**
 * True when the focused element is a TEXT-editing surface (a real text
 * input, textarea, or contenteditable). Everything else — including the
 * volume slider (`<input type="range">`), the metronome / SFX
 * checkboxes (`<input type="checkbox">`), buttons, selects, etc. — is
 * NOT treated as editable, even though it's an `<input>`. Same
 * rationale as the single-player Game.tsx version: chat / pause-menu
 * fields still get to swallow keys, but volume / SFX / metronome
 * controls don't strand the player's lane input the moment they touch
 * a setting.
 */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag === "INPUT") {
    const type = (target as HTMLInputElement).type;
    return (
      type === "text" ||
      type === "search" ||
      type === "url" ||
      type === "email" ||
      type === "tel" ||
      type === "password" ||
      type === "number" ||
      type === ""
    );
  }
  return false;
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
