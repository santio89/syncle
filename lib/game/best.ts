// Per-day, per-song, per-difficulty high-score tracking.
//
// Syncle is "one song per day, infinite tries — your best score wins".
// We persist that best in localStorage keyed by UTC date so the score
// resets at midnight UTC alongside the future daily-rotation logic.
//
// Data is a tiny JSON blob — no PII, fully local. Readers tolerate any
// shape; on a parse error we just treat it as "no best yet".

import { ChartMode } from "./chart";

const STORAGE_PREFIX = "syncle.best.";

export interface DailyBest {
  songId: string;
  mode: ChartMode;
  score: number;
  accuracy: number;
  maxCombo: number;
  /** UTC date string (YYYY-MM-DD) at the moment the score was set. */
  date: string;
  /** Wall-clock timestamp (ms) the score was saved. */
  at: number;
}

/** UTC YYYY-MM-DD, e.g. "2026-04-16". Used as the daily reset boundary. */
export function todayUtcKey(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** localStorage key for the best of the day for a given song + mode. */
export function bestKey(songId: string, mode: ChartMode): string {
  return `${STORAGE_PREFIX}${todayUtcKey()}.${songId}.${mode}`;
}

/** Load the best for a key, or null if no run today (or storage unavailable). */
export function loadBest(key: string): DailyBest | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DailyBest;
    if (typeof parsed.score !== "number") return null;
    // Sanity check: only honor entries whose stored UTC date matches today.
    // (Old entries would already have rotated keys, but belt + suspenders.)
    if (parsed.date && parsed.date !== todayUtcKey()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export interface SaveResult {
  /** The best after this save (either the candidate or the prior best). */
  best: DailyBest;
  /** True if the candidate beat the previous best (or there was none). */
  improved: boolean;
}

/**
 * Save `candidate` only if it beats the existing best for `key`.
 * Returns the resulting best + whether the candidate set a new high.
 */
export function saveBestIfHigher(
  key: string,
  candidate: DailyBest,
): SaveResult {
  const prev = loadBest(key);
  if (prev && prev.score >= candidate.score) {
    return { best: prev, improved: false };
  }
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(key, JSON.stringify(candidate));
    } catch {
      /* storage full / disabled — best-effort only */
    }
  }
  return { best: candidate, improved: true };
}
