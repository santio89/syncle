/**
 * Solo run resume state — sessionStorage shim that lets a player who
 * accidentally refreshes the page mid-song pick the same song back up
 * with one click instead of having to roll a fresh random chart.
 *
 * Scope decisions:
 *
 *   - **Session, not local** — `sessionStorage` (not `localStorage`)
 *     so the resume state goes away when the player closes the tab
 *     entirely. We only want to recover from accidental refreshes /
 *     navigation away within the same browsing session; carrying a
 *     "you were playing X yesterday" prompt across days would be
 *     noise.
 *
 *   - **Song + mode + savedAt only** — we deliberately do NOT
 *     persist the player's mid-song stats (score, combo, hits) or
 *     the audio offset. Restoring those faithfully would require
 *     reconstructing the GameState's internal cursor, replaying
 *     hold-note tail logic, and seeking the audio buffer to a
 *     half-played frame — each of which has subtle ways to drift
 *     out of sync that are very hard to debug.
 *
 *     Instead we save just enough to reload the SAME song at the
 *     SAME difficulty from the start. The player gets a one-click
 *     re-attempt instead of being kicked back to a brand-new
 *     random song. That's the actual UX win — preserving the run
 *     state to the note is a stretch goal we explicitly punt on
 *     to keep the implementation simple and bug-free.
 *
 *   - **TTL** — 30 minutes. Long enough to cover an accidental
 *     refresh, a quick brb, or a transient network issue; short
 *     enough that a player who comes back hours later isn't
 *     prompted with a stale offer. Saved-at timestamp lets us
 *     filter without polluting `sessionStorage` with a separate
 *     expiration cron.
 *
 *   - **Multiplayer, not solo** — multiplayer rejoin is handled
 *     server-side via the session TTL inside the room registry
 *     (a refreshed player reattaches to their slot and the page's
 *     loading effect re-fetches the chart on its own). This file
 *     is solo-only.
 *
 * The shape is forward-compatible: if a future change wants to
 * persist score/offset too, add fields and bump `version`. The
 * loader rejects any payload whose `version` doesn't match the
 * current constant, so a stale shape from a prior tab reload
 * won't blow up the resume prompt.
 */

import type { ChartMode } from "./chart";
import { reportStorageFailure } from "./settings";

const KEY = "syncle.solo.resume";

/**
 * Bumped whenever the on-disk shape changes. Loader returns null
 * for any payload whose version doesn't match — stale records get
 * silently discarded instead of crashing the resume UI.
 */
const VERSION = 1;

/**
 * Maximum age (ms) of a saved resume record before we consider it
 * stale and refuse to surface it. 30 minutes covers refreshes / brb
 * scenarios; anything older is probably "yesterday's session" and
 * not what the player has in their head right now.
 */
export const RESUME_TTL_MS = 30 * 60 * 1000;

export interface SoloResumeState {
  version: typeof VERSION;
  /**
   * Beatmapset ID of the chart that was being played. Resolved via
   * `loadSongById` on resume — bypasses the random `loadSong`
   * pool so we always come back to THIS song.
   */
  beatmapsetId: number;
  /** Difficulty bucket the player had selected. */
  mode: ChartMode;
  /**
   * Display-only metadata so the resume banner can show
   * "Resume <artist> — <title>?" without first re-fetching the
   * chart. Saved at the same time as the run starts so it's
   * cheap to keep around.
   */
  artist: string;
  title: string;
  /** `Date.now()` at save time. Used for TTL filtering. */
  savedAt: number;
}

/**
 * SSR / no-window guard. Solo Game.tsx is dynamically imported
 * with `ssr: false` so this should always have access to
 * `window` in practice, but the guard keeps unit tests + future
 * SSR-safe callers from blowing up.
 */
function hasStorage(): boolean {
  return typeof window !== "undefined" && !!window.sessionStorage;
}

/**
 * Persist the resume state. Called from inside the play loop on a
 * coarse cadence (~once per second is plenty — the saved record
 * carries no time-sensitive data so high-frequency writes are
 * pure overhead). Returns silently on storage failure (quota
 * exceeded, private mode restrictions, etc.) — resume is a
 * convenience feature, not a correctness requirement, and a
 * crashed write should never crash the game.
 */
export function saveSoloResume(
  state: Omit<SoloResumeState, "version" | "savedAt">,
): void {
  if (!hasStorage()) return;
  try {
    const payload: SoloResumeState = {
      ...state,
      version: VERSION,
      savedAt: Date.now(),
    };
    window.sessionStorage.setItem(KEY, JSON.stringify(payload));
  } catch {
    // Swallow at the call-site (resume is a convenience, not a
    // correctness requirement) but surface a single discreet
    // "settings won't persist" toast through the shared
    // storage-health channel so the player isn't left wondering
    // why "Resume last song?" never appears after a refresh.
    reportStorageFailure();
  }
}

/**
 * Read the resume state. Returns null when:
 *   - no record exists,
 *   - the record is older than `RESUME_TTL_MS`,
 *   - the record's `version` doesn't match (stale shape),
 *   - the record fails to parse (corrupted JSON).
 *
 * Stale / mismatched records are eagerly cleared so the next
 * mount doesn't re-evaluate them.
 */
export function loadSoloResume(): SoloResumeState | null {
  if (!hasStorage()) return null;
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SoloResumeState>;
    if (
      !parsed ||
      parsed.version !== VERSION ||
      typeof parsed.beatmapsetId !== "number" ||
      typeof parsed.mode !== "string" ||
      typeof parsed.savedAt !== "number"
    ) {
      window.sessionStorage.removeItem(KEY);
      return null;
    }
    if (Date.now() - parsed.savedAt > RESUME_TTL_MS) {
      window.sessionStorage.removeItem(KEY);
      return null;
    }
    return parsed as SoloResumeState;
  } catch {
    try {
      window.sessionStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
    return null;
  }
}

/**
 * Drop the resume record. Called when the player explicitly
 * dismisses the resume prompt, when they finish a run cleanly
 * (no point offering to resume a song they already completed),
 * or when they "Give up" (same reasoning — they actively chose
 * to exit the run).
 */
export function clearSoloResume(): void {
  if (!hasStorage()) return;
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
