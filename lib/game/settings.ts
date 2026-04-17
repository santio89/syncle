/**
 * Tiny key/value settings store backed by localStorage.
 *
 * Kept separate from `best.ts` because settings are global (not per-day,
 * not per-song) and have very different lifecycle than score persistence.
 */

const VOL_KEY = "syncle.volume";
const DEFAULT_VOLUME = 0.85;

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
