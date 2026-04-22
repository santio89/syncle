// Per-song, per-difficulty lifetime high-score tracking.
//
// Syncle is "random song every refresh, endless retries — push your best".
// Each (songId, mode) pair persists its own all-time best in localStorage.
// Once a Firestore-backed leaderboard ships, the same shape will sync up
// with the cloud copy (`saveBestIfHigher` becomes a `await sync()` call).
//
// Data is a tiny JSON blob — no PII, fully local. Readers tolerate any
// shape; on a parse error we just treat it as "no best yet".

import { ChartMode } from "./chart";

const STORAGE_PREFIX = "syncle.best.";

export interface RunBest {
  songId: string;
  mode: ChartMode;
  score: number;
  accuracy: number;
  maxCombo: number;
  /** Wall-clock timestamp (ms) the BEST score was saved. */
  at: number;
  /**
   * Per-track aggregates updated on every finished run (not just on a new
   * best). Optional so older saved blobs that predate these fields still
   * load — readers should `?? 0` / `?? at` accordingly.
   *
   * `runs`         — total finished runs on this (song, mode) combo.
   * `lastPlayedAt` — wall-clock timestamp (ms) of the most recent run.
   */
  runs?: number;
  lastPlayedAt?: number;
}

/** localStorage key for the lifetime best of a given song + mode. */
export function bestKey(songId: string, mode: ChartMode): string {
  return `${STORAGE_PREFIX}${songId}.${mode}`;
}

/** Load the best for a key, or null if no run yet (or storage unavailable). */
export function loadBest(key: string): RunBest | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RunBest;
    if (typeof parsed.score !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

export interface SaveResult {
  /** The best after this save (either the candidate or the prior best). */
  best: RunBest;
  /** True if the candidate beat the previous best (or there was none). */
  improved: boolean;
}

/**
 * Save `candidate` for `key`. The per-track aggregates (`runs`,
 * `lastPlayedAt`) are ALWAYS bumped — they reflect "you played this track
 * again" regardless of whether you topped your high. The score-bearing
 * fields (`score`, `accuracy`, `maxCombo`, `at`) are only promoted when
 * the candidate actually beat the previous best.
 *
 * Returns the resulting best + whether the candidate set a new high.
 */
export function saveBestIfHigher(
  key: string,
  candidate: RunBest,
): SaveResult {
  const prev = loadBest(key);
  const now = candidate.lastPlayedAt ?? candidate.at ?? Date.now();
  const runs = (prev?.runs ?? 0) + 1;
  const improved = !prev || candidate.score > prev.score;

  // Always-fresh fields land on whichever record (prev or candidate) gets
  // promoted. We carry the score-bearing fields from the *winner*, then
  // overlay the bumped aggregates.
  const winner: RunBest = improved ? candidate : prev!;
  const next: RunBest = {
    ...winner,
    runs,
    lastPlayedAt: now,
  };

  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* storage full / disabled — best-effort only */
    }
  }
  return { best: next, improved };
}
