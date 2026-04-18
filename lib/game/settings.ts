/**
 * Tiny key/value settings store backed by localStorage.
 *
 * Kept separate from `best.ts` because settings are global (not per-day,
 * not per-song) and have very different lifecycle than score persistence.
 */

const VOL_KEY = "syncle.volume";
const DEFAULT_VOLUME = 0.85;
const FPS_LOCK_KEY = "syncle.fpsLock";

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
