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
// SHIFT and SPACE are no longer used — osu!mania 4K beatmaps only have 4
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
export const LANE_COLORS: Record<number, string> = {
  0: "#ff3b6b", // D / ← — red
  1: "#ffd23f", // F / ↓ — yellow
  2: "#3dff8a", // J / ↑ — green
  3: "#3da9ff", // K / → — blue (brand accent)
};

/** Pitches used by the audio feedback when a lane is hit. A minor pentatonic. */
export const LANE_PITCH: Record<number, number> = {
  0: 220.0,   // A3
  1: 261.63,  // C4
  2: 329.63,  // E4
  3: 440.0,   // A4
};

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
}

export type Judgment = "perfect" | "great" | "good" | "miss";

// Timing windows (seconds). A bit forgiving so it always FEELS like you
// got the rhythm right when you press near the beat.
export const TIMING = {
  perfect: 0.06,
  great: 0.11,
  good: 0.16,
  miss: 0.19,
} as const;

export const JUDGMENT_SCORE: Record<Judgment, number> = {
  perfect: 100,
  great: 65,
  good: 30,
  miss: 0,
};

/** Combo multiplier table — every 10 combo bumps a tier. Caps at ×4. */
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
  difficulty: "easy" | "normal" | "hard" | "expert";
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
}

export const INITIAL_STATS: PlayerStats = {
  score: 0,
  combo: 0,
  maxCombo: 0,
  multiplier: 1,
  hits: { perfect: 0, great: 0, good: 0, miss: 0 },
  notesPlayed: 0,
  totalNotes: 0,
  health: 0.6,
};
