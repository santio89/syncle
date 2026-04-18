// Lifetime, account-less play stats persisted in localStorage.
//
// Used to back the homepage scoreboard now that Syncle is "random song every
// refresh, endless retries". Daily framing was retired with the Firestore
// scheduler — when that lands, these stats become the local cache of the
// player's cloud profile (same field names, just synced).
//
// All writes are best-effort: on quota/disabled storage we silently drop.

import { ChartMode } from "./chart";

const STORAGE_KEY = "syncle.stats.v1";

export interface BestEverEntry {
  songId: string;
  songTitle: string;
  songArtist: string;
  mode: ChartMode;
  score: number;
  accuracy: number;
  maxCombo: number;
  at: number;
}

export interface LifetimeStats {
  /** Total finished runs (any difficulty, any song). Includes failed runs. */
  totalRuns: number;
  /** Unique song ids the player has ever finished a run on. */
  tracksPlayed: string[];
  /** Highest score across every (song, mode) combination. */
  bestEver: BestEverEntry | null;
}

const EMPTY_STATS: LifetimeStats = {
  totalRuns: 0,
  tracksPlayed: [],
  bestEver: null,
};

export function loadStats(): LifetimeStats {
  if (typeof window === "undefined") return { ...EMPTY_STATS };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...EMPTY_STATS };
    const parsed = JSON.parse(raw) as Partial<LifetimeStats>;
    return {
      totalRuns:
        typeof parsed.totalRuns === "number" ? parsed.totalRuns : 0,
      tracksPlayed: Array.isArray(parsed.tracksPlayed)
        ? parsed.tracksPlayed.filter((x): x is string => typeof x === "string")
        : [],
      bestEver:
        parsed.bestEver && typeof parsed.bestEver.score === "number"
          ? (parsed.bestEver as BestEverEntry)
          : null,
    };
  } catch {
    return { ...EMPTY_STATS };
  }
}

function save(stats: LifetimeStats): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stats));
  } catch {
    /* quota / disabled — best-effort only */
  }
}

export interface RecordedRun {
  songId: string;
  songTitle: string;
  songArtist: string;
  mode: ChartMode;
  score: number;
  accuracy: number;
  maxCombo: number;
}

/**
 * Update lifetime stats with a freshly finished run. Always increments
 * totalRuns; adds the songId to `tracksPlayed` if not already present;
 * promotes `bestEver` if this run beats the previous all-time score.
 *
 * Returns the post-update snapshot so the caller can re-render without
 * an extra `loadStats()` round-trip.
 */
export function recordRun(run: RecordedRun): LifetimeStats {
  const cur = loadStats();
  const next: LifetimeStats = {
    totalRuns: cur.totalRuns + 1,
    tracksPlayed: cur.tracksPlayed.includes(run.songId)
      ? cur.tracksPlayed
      : [...cur.tracksPlayed, run.songId],
    bestEver:
      !cur.bestEver || run.score > cur.bestEver.score
        ? {
            songId: run.songId,
            songTitle: run.songTitle,
            songArtist: run.songArtist,
            mode: run.mode,
            score: run.score,
            accuracy: run.accuracy,
            maxCombo: run.maxCombo,
            at: Date.now(),
          }
        : cur.bestEver,
  };
  save(next);
  return next;
}
