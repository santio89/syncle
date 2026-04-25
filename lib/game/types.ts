// Core types for the rhythm engine.
//
// Lane layout (4 lanes, exactly matching osu!mania 4K):
//   0 = D / ←
//   1 = F / ↓
//   2 = J / ↑
//   3 = K / →
//
// Each lane accepts EITHER a letter key OR the matching arrow key. Both
// inputs feel identical so right-handed and left-handed players are happy.
//
// SHIFT and SPACE are no longer used - osu!mania 4K beatmaps only have 4
// columns, so the old "special" bars never had any notes to hit.

export const MAIN_LANE_COUNT = 4;
export const TOTAL_LANES = MAIN_LANE_COUNT;

/** Big label shown on each lane gate. */
export const LANE_LABEL: Record<number, string> = {
  0: "D",
  1: "F",
  2: "J",
  3: "K",
};

/** Secondary label (the arrow key alternative). */
export const LANE_ALT_LABEL: Record<number, string> = {
  0: "←",
  1: "↓",
  2: "↑",
  3: "→",
};

/** Distinct, vibrant colors per lane. */
export const LANE_COLORS: readonly string[] = [
  "#ff3b6b", // 0: D / ← - red
  "#ffd23f", // 1: F / ↓ - yellow
  "#3dff8a", // 2: J / ↑ - green
  "#3da9ff", // 3: K / → - blue (brand accent)
];

export interface Note {
  id: number;
  /** Time in seconds (song time) when the note must be hit. */
  t: number;
  /**
   * For hold notes: the song-time when the player must release. For taps
   * this is undefined (or === t). A note is treated as a hold whenever
   * `endT > t + 0.05`.
   */
  endT?: number;
  /** Lane index 0..3. */
  lane: number;

  /** Internal: filled at runtime once the head is judged. */
  judged?: Judgment;
  /** Internal: songTime at which the head was judged. */
  judgedAt?: number;
  /** Internal: true between head-press and release for an active hold. */
  holding?: boolean;
  /** Internal: tail judgment for a hold note (mirrors `judged` for taps). */
  tailJudged?: Judgment;
  /** Internal: songTime at which the tail was judged (for fade-out). */
  tailJudgedAt?: number;
}

export type Judgment = "perfect" | "great" | "good" | "miss";

// Timing windows (seconds). A bit forgiving so it always FEELS like you
// got the rhythm right when you press near the beat.
export const TIMING = {
  perfect: 0.06,
  great: 0.11,
  good: 0.16,
  miss: 0.19,
  /**
   * "Strict Inputs" spam grace (seconds).
   *
   * When a press lands with NO note in the standard hit window
   * (`good`), the engine checks whether any unjudged note exists in
   * the same lane within ±SPAM_GRACE of the press time. If yes, the
   * press is treated as an "honest mistime" - no penalty (the player
   * tried, just slightly off - same forgiving behavior as before).
   * If no, the press is classified as spam / mash and converted into
   * a silent combo break.
   *
   * Why 0.22 s:
   *   - Just outside the `good` (±0.16 s) and `miss` (±0.19 s)
   *     windows. So a player who genuinely tried to hit a note but
   *     was 200 ms early/late won't get classified as spam - the
   *     note registers as a normal miss via `expireMisses` instead.
   *   - Tight enough that pressing during true silence (no notes
   *     within ~440 ms total in the lane) is unambiguously spam,
   *     which is exactly the "panic mash" pattern we want to deter.
   *   - Aligns roughly with the human reaction floor (~200-250 ms),
   *     so the rule reads as "if you couldn't possibly have been
   *     reacting to a note here, don't reward the press".
   *
   * Only consulted when `strictInputs` is on (see lib/game/settings).
   * With the setting off the engine never invokes the check and
   * every empty press is silent + free, matching pre-Strict
   * behavior 1:1.
   */
  spamGrace: 0.22,
} as const;

export const JUDGMENT_SCORE: Record<Judgment, number> = {
  perfect: 100,
  great: 65,
  good: 30,
  miss: 0,
};

/** Combo multiplier table - every 10 combo bumps a tier. Caps at ×4. */
export const COMBO_MULTIPLIERS = [1, 2, 3, 4, 4, 4];

export interface SongMeta {
  id: string;
  title: string;
  artist: string;
  year?: number;
  bpm: number;
  /** Seconds of silence/lead-in before the first beat lands. */
  offset: number;
  /** Path under /public. */
  audioUrl: string;
  /** Total duration in seconds (best effort). */
  duration: number;
  difficulty: "easy" | "normal" | "hard" | "insane" | "expert";
  /**
   * Public URL for the beatmap cover art - osu CDN for remote songs,
   * potentially a /public asset for local fallbacks. Optional: local
   * fallbacks that don't ship art will leave this undefined and the
   * UI is expected to render plainly.
   */
  coverUrl?: string;
  /**
   * Beatmapset moderation status from the search API ("ranked",
   * "loved", "qualified", "approved"). Surfaced as a small badge in
   * the UI. Undefined for local songs.
   */
  status?: string;
  /** Mapper username (e.g. "AlexDunk"). Credit line in the UI. */
  creator?: string;
}

export interface PlayerStats {
  score: number;
  combo: number;
  maxCombo: number;
  multiplier: number;
  hits: { perfect: number; great: number; good: number; miss: number };
  notesPlayed: number;
  totalNotes: number;
  health: number; // 0..1
  /**
   * Monotonic counter of "meaningful combo breaks" - incremented every
   * time a miss/early-release resets a combo of ≥ COMBO_BREAK_THRESHOLD
   * (20) to zero. The render loop watches this counter as a level-edge
   * trigger to fire `audio.playComboBreak()` exactly once per break,
   * regardless of inter-frame timing (a miss followed immediately by a
   * hit can leave `combo` at 1 by the time the next rAF reads it, so a
   * naive `prev >= 20 && now === 0` check would miss the event).
   *
   * Audio-only - never read by the engine itself or surfaced to the
   * scoreboard. The standard miss tally lives in `hits.miss`.
   */
  comboBreaks: number;
}

export const INITIAL_STATS: PlayerStats = {
  score: 0,
  combo: 0,
  maxCombo: 0,
  multiplier: 1,
  hits: { perfect: 0, great: 0, good: 0, miss: 0 },
  notesPlayed: 0,
  totalNotes: 0,
  // Rock meter starts empty (0) and fills as the player lands hits, so
  // the bar visibly grows from nothing during the run instead of
  // pre-loading the player at 60%. Hitting a perfect adds +0.012,
  // great/good +0.006, miss -0.04 - see `lib/game/engine.ts`. The bar
  // is purely a UI indicator (no game-over threshold), so starting at
  // 0 is safe.
  health: 0,
  comboBreaks: 0,
};

/**
 * Minimum combo length at which a break fires the dedicated
 * combo-break SFX. Mirrors osu!'s convention: small streak losses
 * are silent (you barely felt the streak existed), but breaking a
 * 20+ chain plays a distinct, slightly jarring cue so the player
 * registers what they just lost.
 */
export const COMBO_BREAK_THRESHOLD = 20;
