/**
 * Tiny key/value settings store backed by localStorage.
 *
 * Kept separate from `best.ts` because settings are global (not per-day,
 * not per-song) and have very different lifecycle than score persistence.
 */

const VOL_KEY = "syncle.volume";
// Default music volume on first launch (when no persisted value is found).
// 0.5 = 50% — half of the perceptually-tapered slider, which lands at
// roughly 44% perceived loudness with the song bus's quadratic curve
// and ~70% perceived on the SFX bus's gentler square-root curve. This
// is the "polite default": loud enough that a brand-new player hears
// the chart and the input feedback clearly on first launch, quiet
// enough that we don't blow out anyone wearing headphones at full
// system volume. Was 1.0 historically; landing at 50% gives the slider
// usable headroom in BOTH directions out of the box, which matters
// more now that the taper is honest end-to-end.
const DEFAULT_VOLUME = 0.5;
const FPS_LOCK_KEY = "syncle.fpsLock";
const SFX_KEY = "syncle.sfx";
const DEFAULT_SFX = true;
const METRONOME_KEY = "syncle.metronome";
const DEFAULT_METRONOME = true;

/**
 * Optional render-loop frame-rate cap.
 *
 * - `null`  → uncapped (one draw per vblank — 60Hz on most monitors,
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
    /* ignore */
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
    /* ignore */
  }
}

/**
 * Input sound effects toggle. When `false`, the engine suppresses
 * hit / miss / release / combo-milestone SFX (and the song's "duck"
 * cue that fires on a miss). The metronome and song playback itself
 * are deliberately NOT affected — those have their own controls and
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
    /* ignore */
  }
}

/**
 * Metronome (audible click track on every beat) toggle. Local only —
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
    /* ignore */
  }
}
