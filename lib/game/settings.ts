/**
 * Tiny key/value settings store backed by localStorage.
 *
 * Kept separate from `best.ts` because settings are global (not per-day,
 * not per-song) and have very different lifecycle than score persistence.
 */

const VOL_KEY = "syncle.volume";
// Default music volume on first launch (when no persisted value is found).
// 0.5 = 50% - half of the perceptually-tapered slider, which lands at
// roughly 44% perceived loudness with the song bus's quadratic curve
// and ~70% perceived on the SFX bus's gentler square-root curve. This
// is the "polite default": loud enough that a brand-new player hears
// the chart and the feedback SFX clearly on first launch, quiet
// enough that we don't blow out anyone wearing headphones at full
// system volume. Was 1.0 historically; landing at 50% gives the slider
// usable headroom in BOTH directions out of the box, which matters
// more now that the taper is honest end-to-end.
const DEFAULT_VOLUME = 0.5;
const FPS_LOCK_KEY = "syncle.fpsLock";
const SFX_KEY = "syncle.sfx";
const DEFAULT_SFX = true;
const METRONOME_KEY = "syncle.metronome";
// Off by default - most players treat the metronome as a learning aid
// for unfamiliar tracks rather than a permanent gameplay layer, and a
// surprise click on every beat the first time the app loads reads as a
// bug instead of a feature. Players who want it can flip it on from
// the StartCard / HUD / Lobby tile (key: M); the choice persists in
// `METRONOME_KEY` across sessions.
const DEFAULT_METRONOME = false;
const STRICT_INPUTS_KEY = "syncle.strictInputs";
// On by default - without it, players who panic-mash all four lanes
// at high frequency get rewarded with perfect/great judgments because
// every press lands within the generous (±160 ms) "good" window of
// SOME note in SOME lane. This converts spam into a silent combo
// break (see `GameState.markEmptyPress`), which preserves the
// "honest mistime is fine" feel while making bad-faith mash visibly
// cost the player. Players who want classic osu!mania scoring (no
// penalty for unrelated taps) can flip it off in the settings tile.
const DEFAULT_STRICT_INPUTS = true;
const QUALITY_KEY = "syncle.quality";
// High (Quality) is the default - the canvas is tuned to look its
// best with the full VFX reel (particles, shockwaves, glow halos,
// milestone vignette, lane-gate anticipation), and modern GPUs
// (including integrated ones on recent laptops) handle it cleanly.
// Players on low-end hardware, on battery, or who prefer a calmer
// canvas can flip to PERFORMANCE from the StartCard / HUD / Lobby
// tile; the choice persists across sessions in `QUALITY_KEY`.
const DEFAULT_QUALITY: RenderQuality = "high";
const PERSPECTIVE_KEY = "syncle.perspective";
// 2D (osu!-style flat lanes) is the default: parallel rails,
// constant note size, no perspective depth. Chosen as the default
// because player feedback flagged the 3D perspective highway as
// disorienting for a subset of players (the notes grew as they
// approached and the rails converged, which paired with flat
// 2D input buttons read as inconsistent and mildly dizzying).
// The 2D view is the stabler "first impression" - flat playfield,
// flat inputs, flat notes, everything in the screen plane.
// Players who prefer the Guitar Hero / Rock Band look can flip
// to `"3d"` from the StartCard / HUD / Lobby tile; the choice
// persists in `PERSPECTIVE_KEY` across sessions. The switch is
// purely visual - gameplay math (timing windows, hit registration,
// scoring) is identical in both modes, so it's stored as a per-
// player preference and never synced over the multiplayer wire.
const DEFAULT_PERSPECTIVE_MODE: PerspectiveMode = "2d";

/* -----------------------------------------------------------------------
 * Storage-health signal - fires the first time a settings / resume /
 * best-score write fails (quota exceeded, private mode, etc.). Components
 * can subscribe via `onStorageFailure` to surface a single discreet
 * "settings won't persist" toast so the player isn't silently surprised
 * later. Idempotent per session - we don't spam the listener after the
 * first failure since every subsequent save attempt would re-fire it.
 * ------------------------------------------------------------------- */

let storageFailureFired = false;
const storageFailureListeners = new Set<() => void>();

/**
 * Record a localStorage / sessionStorage write failure. Safe to call
 * from any try/catch arm - first call notifies listeners, subsequent
 * calls are no-ops for the rest of the session.
 */
export function reportStorageFailure(): void {
  if (storageFailureFired) return;
  storageFailureFired = true;
  for (const cb of storageFailureListeners) {
    try {
      cb();
    } catch {
      /* swallow - listener errors must not poison sibling listeners */
    }
  }
}

/**
 * Subscribe to the first storage failure. Returns an unsubscribe
 * function. If a failure has ALREADY been reported when the caller
 * subscribes (e.g. a save failed in a render-loop tick before the HUD
 * mounted), the listener fires synchronously so late subscribers still
 * see the signal.
 */
export function onStorageFailure(cb: () => void): () => void {
  storageFailureListeners.add(cb);
  if (storageFailureFired) {
    try {
      cb();
    } catch {
      /* swallow */
    }
  }
  return () => {
    storageFailureListeners.delete(cb);
  };
}

/** True if a write has failed at least once this session. */
export function hasStorageFailed(): boolean {
  return storageFailureFired;
}

/**
 * Optional render-loop frame-rate cap.
 *
 * - `null`  → uncapped (one draw per vblank - 60Hz on most monitors,
 *             144/200/240 Hz on high-refresh displays).
 * - `30/60` → render at most that many frames per second. The rAF loop
 *             still wakes every vblank but skips the draw call until the
 *             frame budget has elapsed, so the audio clock + input
 *             scheduling stay sample-accurate even under a render cap.
 *
 * Useful on laptops to extend battery life, on integrated GPUs that
 * struggle to hit 200 Hz, or just to keep fans quiet when the player
 * doesn't need every available frame.
 */
export type FpsLock = 30 | 60 | null;

/** Cycle order for the in-game lock toggle: off → 30 → 60 → off. */
export const FPS_LOCK_CYCLE: FpsLock[] = [null, 30, 60];

export function nextFpsLock(current: FpsLock): FpsLock {
  const i = FPS_LOCK_CYCLE.indexOf(current);
  return FPS_LOCK_CYCLE[(i + 1) % FPS_LOCK_CYCLE.length];
}

export function loadFpsLock(): FpsLock {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(FPS_LOCK_KEY);
    if (raw == null || raw === "off" || raw === "null") return null;
    const n = parseInt(raw, 10);
    if (n === 30 || n === 60) return n;
    return null;
  } catch {
    return null;
  }
}

export function saveFpsLock(v: FpsLock): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(FPS_LOCK_KEY, v == null ? "off" : String(v));
  } catch {
    reportStorageFailure();
  }
}

/* -----------------------------------------------------------------------
 * Render quality preset.
 *
 * - `"high"`       → full visual feedback: particles, shockwaves, glow
 *                    halos, milestone vignette, lane-gate anticipation.
 *                    The default and what every player sees out of the
 *                    box. Tuned to look great on a desktop GPU.
 *
 * - `"performance"` → pruned VFX for low-end / integrated GPUs and
 *                     accessibility-conscious players who want a
 *                     calmer canvas. Particles + shockwaves + the
 *                     milestone vignette + the canvas combo glow are
 *                     skipped entirely; lane-gate and tap-note
 *                     shadowBlur are also disabled (the most
 *                     fillrate-expensive operations on the highway).
 *                     Notes, hold trails, judgment line, and beat
 *                     dot are still drawn - gameplay reads identical,
 *                     just without the celebratory polish.
 *
 * Live-applied via `RenderOptions.quality` - the renderer's hot
 * paths gate the heavy effects on this flag without re-allocating
 * any state, so toggling the setting mid-match takes effect on the
 * next frame.
 * ------------------------------------------------------------------- */
export type RenderQuality = "high" | "performance";

/** Cycle order for the in-game quality toggle. */
export const QUALITY_CYCLE: RenderQuality[] = ["high", "performance"];

export function nextRenderQuality(current: RenderQuality): RenderQuality {
  return current === "high" ? "performance" : "high";
}

export function loadRenderQuality(): RenderQuality {
  if (typeof window === "undefined") return DEFAULT_QUALITY;
  try {
    const raw = window.localStorage.getItem(QUALITY_KEY);
    if (raw === "performance") return "performance";
    if (raw === "high") return "high";
    return DEFAULT_QUALITY;
  } catch {
    return DEFAULT_QUALITY;
  }
}

export function saveRenderQuality(v: RenderQuality): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(QUALITY_KEY, v);
  } catch {
    reportStorageFailure();
  }
}

/* -----------------------------------------------------------------------
 * Playfield perspective mode.
 *
 * Controls the geometry of the highway, notes, rails, and hold trails:
 *
 * - `"3d"` → the Guitar Hero / Rock Band layout that has always
 *            shipped. The highway is a trapezoid: top edge at 50% of
 *            the bottom width, rails converge toward the top, notes
 *            and hold trails scale from ~15 px wide at the top to
 *            ~26 px at the judgment line. Beat lines also taper
 *            horizontally to match the rail slope. Gives the game
 *            visible depth and a "rushing toward the player" feel.
 *
 * - `"2d"` → osu!mania-style flat layout. Top edge = bottom edge
 *            (rectangular highway), rails are perfectly vertical,
 *            notes are a constant size, hold trails are constant
 *            width. Pairs better with the flat 2D lane-gate buttons
 *            at the bottom, eliminating the 2D/3D mismatch that
 *            several players reported as mildly disorienting.
 *
 * Gameplay math (timing windows, hit registration, scoring,
 * combo/score deltas, replay-worthy events) is IDENTICAL in both
 * modes - this is a purely visual choice. Because it's purely
 * visual, the setting is local-only (like Quality, FPS lock,
 * metronome, feedback) and never synced over the multiplayer wire.
 * Two players in the same room can run different perspective modes
 * without any impact on fairness or leaderboard comparability.
 * ------------------------------------------------------------------- */
export type PerspectiveMode = "2d" | "3d";

/** Cycle order for the in-game View toggle. */
export const PERSPECTIVE_CYCLE: PerspectiveMode[] = ["2d", "3d"];

export function nextPerspectiveMode(current: PerspectiveMode): PerspectiveMode {
  return current === "3d" ? "2d" : "3d";
}

export function loadPerspectiveMode(): PerspectiveMode {
  if (typeof window === "undefined") return DEFAULT_PERSPECTIVE_MODE;
  try {
    const raw = window.localStorage.getItem(PERSPECTIVE_KEY);
    if (raw === "2d") return "2d";
    if (raw === "3d") return "3d";
    return DEFAULT_PERSPECTIVE_MODE;
  } catch {
    return DEFAULT_PERSPECTIVE_MODE;
  }
}

export function savePerspectiveMode(v: PerspectiveMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PERSPECTIVE_KEY, v);
  } catch {
    reportStorageFailure();
  }
}

export function loadVolume(): number {
  if (typeof window === "undefined") return DEFAULT_VOLUME;
  try {
    const raw = window.localStorage.getItem(VOL_KEY);
    if (raw == null) return DEFAULT_VOLUME;
    const v = parseFloat(raw);
    if (!Number.isFinite(v)) return DEFAULT_VOLUME;
    return Math.min(1, Math.max(0, v));
  } catch {
    return DEFAULT_VOLUME;
  }
}

export function saveVolume(v: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(VOL_KEY, String(Math.min(1, Math.max(0, v))));
  } catch {
    reportStorageFailure();
  }
}

/**
 * Input sound effects toggle. When `false`, the engine suppresses
 * hit / miss / release / combo-milestone SFX (and the song's "duck"
 * cue that fires on a miss). The metronome and song playback itself
 * are deliberately NOT affected - those have their own controls and
 * silencing them here would surprise the player.
 */
export function loadSfx(): boolean {
  if (typeof window === "undefined") return DEFAULT_SFX;
  try {
    const raw = window.localStorage.getItem(SFX_KEY);
    if (raw == null) return DEFAULT_SFX;
    return raw === "1" || raw === "true" || raw === "on";
  } catch {
    return DEFAULT_SFX;
  }
}

export function saveSfx(on: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SFX_KEY, on ? "1" : "0");
  } catch {
    reportStorageFailure();
  }
}

/**
 * Metronome (audible click track on every beat) toggle. Local only -
 * never affects other players in multiplayer. Mirrored into the
 * AudioEngine via `setMetronome` when the React state changes.
 */
export function loadMetronome(): boolean {
  if (typeof window === "undefined") return DEFAULT_METRONOME;
  try {
    const raw = window.localStorage.getItem(METRONOME_KEY);
    if (raw == null) return DEFAULT_METRONOME;
    return raw === "1" || raw === "true" || raw === "on";
  } catch {
    return DEFAULT_METRONOME;
  }
}

export function saveMetronome(on: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(METRONOME_KEY, on ? "1" : "0");
  } catch {
    reportStorageFailure();
  }
}

/**
 * Strict Inputs (anti-mash protection) toggle.
 *
 * When ON: an empty key press with NO unjudged note in the same lane
 * within ±TIMING.spamGrace (~220 ms) silently breaks the player's
 * combo and applies a small health drop. No on-screen MISS popup, no
 * song wobble - the combo number visibly dropping is the entire
 * feedback. This makes panic-mashing all four lanes a net negative
 * even on charts with wide hit windows, while leaving honest
 * early/late presses (note actually approaching) completely
 * unpenalized.
 *
 * When OFF: empty presses are silently ignored and play only the
 * existing soft "tick" SFX - the legacy osu!mania-style behavior. No
 * combo / health / score impact whatsoever.
 *
 * Local-only setting (mirrors Quality / FPS Lock / Metronome) - never
 * synced over the multiplayer wire. Two players in the same room can
 * run different Strict Inputs modes; each player's own engine
 * applies their own preference to their own inputs.
 */
export function loadStrictInputs(): boolean {
  if (typeof window === "undefined") return DEFAULT_STRICT_INPUTS;
  try {
    const raw = window.localStorage.getItem(STRICT_INPUTS_KEY);
    if (raw == null) return DEFAULT_STRICT_INPUTS;
    return raw === "1" || raw === "true" || raw === "on";
  } catch {
    return DEFAULT_STRICT_INPUTS;
  }
}

export function saveStrictInputs(on: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STRICT_INPUTS_KEY, on ? "1" : "0");
  } catch {
    reportStorageFailure();
  }
}
