import { Note, SongMeta } from "./types";
import { parseOsu } from "./osu";
import {
  fetchAndExtractAll,
  ExtractedChart,
  ExtractedSongFull,
  pickRandomManiaBeatmapsetId,
} from "./oszFetcher";

/**
 * Empty skeleton meta used as the type-safe initial state before a real
 * chart finishes loading. The UI must check for `meta.title === ""` and
 * show a loading state instead of rendering this placeholder.
 */
export const PLACEHOLDER_META: SongMeta = {
  id: "",
  title: "",
  artist: "",
  bpm: 120,
  offset: 0,
  audioUrl: "",
  duration: 0,
  difficulty: "easy",
};

/* ------------------------------------------------------------------------- */
/* Difficulty quantization                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Syncle difficulty modes — five universal tiers that mirror osu!mania's
 * own naming scheme (easy / normal / hard / insane / expert), so the same
 * vocabulary works across the homepage card, the in-game picker, the
 * multiplayer lobby, and the saved-score keys.
 *
 * Resolution model — every tier owns a calibrated nps band (see
 * {@link TIER_BANDS}). A tier is honoured only when we can deliver a
 * chart whose real density falls inside its band; everything else is
 * disabled. This guarantees a Hard always feels like a Hard and an Easy
 * is never accidentally a 14-nps stream, no matter what the source song
 * looked like.
 *
 *   1. Mapper-provided chart for this bucket — assignment in
 *      {@link assignBucket} validates the chart's nps against the band,
 *      so a "Hard"-named chart at 14 nps gets re-bucketed to Expert
 *      where it actually belongs. Mapper Expert above the band's max
 *      (e.g. a 25-nps Lunatic) is thinned down to the band target so
 *      no absurd-density chart ever reaches the player.
 *
 *   2. Synthesis from the densest mapper chart in the song:
 *        easy / normal → beat-grid pass first (snaps notes to whole
 *                        or half beats for musicality), then a
 *                        density-targeted subsample if the grid result
 *                        lands outside band
 *        hard / insane → density-targeted subsample (computes the exact
 *                        tap-fraction to land at band target)
 *        expert        → mapper-only (can't synthesize denser than the
 *                        densest chart in the song)
 *
 *      Holds are always preserved across synthesis — losing a sustain
 *      would silently drop a phrase of the song.
 *
 * A mode is marked unavailable in `ModeAvailability` and disabled in
 * the UI when no source can produce a chart inside the tier's band.
 *
 * NOTE on the wire/storage value `"normal"`: we keep that string for the
 * second tier instead of renaming to `"medium"` because localStorage best
 * keys, the multiplayer protocol, and persisted run history all reference
 * it. The user-facing label is mapped to `"medium"` via {@link displayMode}.
 */
export type ChartMode = "easy" | "normal" | "hard" | "insane" | "expert";

/**
 * Difficulty order, easiest → hardest. Used for picker layout, walking
 * to the next-available mode when a song doesn't ship the requested
 * difficulty, and computing the homepage card's "lowest available" label.
 */
export const MODE_ORDER: ChartMode[] = [
  "easy",
  "normal",
  "hard",
  "insane",
  "expert",
];

const DEFAULT_MODE: ChartMode = "easy";

/**
 * Map an internal {@link ChartMode} to the label we actually show users.
 * `"normal"` displays as `"medium"`; everything else is identity.
 */
export function displayMode(
  mode: ChartMode,
): "easy" | "medium" | "hard" | "insane" | "expert" {
  return mode === "normal" ? "medium" : mode;
}

/**
 * Canonical "intensity stars" for each tier. We keep this fixed (1..5,
 * easy → expert) instead of deriving it from the loaded chart's nps so
 * the rating means the same thing across every song the player ever
 * sees: an Insane in song A and an Insane in song B both render four
 * stars, full stop. That predictability is what makes the badge useful
 * as a HUD tag and as a picker label.
 */
export function modeStars(mode: ChartMode): 1 | 2 | 3 | 4 | 5 {
  const i = MODE_ORDER.indexOf(mode);
  return ((i >= 0 ? i : 0) + 1) as 1 | 2 | 3 | 4 | 5;
}

/* ------------------------------------------------------------------------- */
/* Difficulty density bands — the source of truth for "what is a Hard?"      */
/* ------------------------------------------------------------------------- */

/**
 * Per-tier notes-per-second band. The same numbers govern THREE different
 * decisions, which is why they live in one place:
 *
 *   1. Mapper-shipped chart validation. A mapper-named "Hard" only counts
 *      as Hard if its real density falls in `[min, max]`. A "Hard" chart
 *      at 14 nps is misclassified — we re-bucket it into Insane or Expert
 *      based on the density band that actually contains it.
 *
 *   2. Synthesis target. When a tier has no mapper chart, we thin the
 *      densest available source down to `target` nps. Player gets a chart
 *      that always feels like that tier across every song they ever
 *      play — Hard at 5.8 nps, Insane at 8 nps, no surprises.
 *
 *   3. Synthesis sanity check. The thinned result must land inside
 *      `[min, max]`. If a quirky source produces a synthesis that lands
 *      outside (e.g. grid quantization at unusual BPMs), we fall back to
 *      raw subsample. If even that fails, the tier is disabled — better
 *      to show a clean "unavailable" than a misleading button.
 *
 * Bands are deliberately calibrated against the typical osu!mania 4K
 * density spread (Easy ≈ 1.5-3.5 nps, ..., Expert ≈ 9.5+ nps) and overlap
 * by ~0.5 nps at boundaries so a borderline 5.0-nps chart can land in
 * either Normal or Hard depending on the mapper's intent.
 *
 * Expert has a real upper cap (22 nps) — anything denser than that gets
 * thinned down on display. The result: no "Expert" with 100 nps madness
 * ever escapes onto a player's screen. The original count survives in the
 * "raw" badge so the curious can still see what the chart was natively.
 */
const TIER_BANDS: Record<
  ChartMode,
  { min: number; max: number; target: number }
> = {
  easy: { min: 1.5, max: 3.5, target: 2.5 },
  normal: { min: 3.0, max: 5.0, target: 4.0 },
  hard: { min: 4.5, max: 7.5, target: 5.8 },
  insane: { min: 6.5, max: 10.5, target: 8.5 },
  // Expert max isn't infinity on purpose — see capping logic in resolveTier.
  expert: { min: 9.5, max: 22.0, target: 13.0 },
};

/**
 * Tier whose `[min, max]` band contains `nps`. Used both for re-bucketing
 * misclassified mapper charts and for "purely density-driven" classification
 * when the mapper's name gives us nothing to go on.
 *
 * Bands overlap at boundaries — we walk from easiest to hardest and return
 * the FIRST band that contains the value, which biases ambiguous densities
 * toward the easier tier (a 4.7-nps chart is "still kinda Normal" rather
 * than "barely Hard"). Mappers tend to over-rate their charts, not under-
 * rate them, so this matches reader expectations.
 *
 * Below the easy floor → easy (impossibly sparse charts shouldn't unlock
 * anything harder). Above expert.max → expert (the cap will thin them down
 * for display).
 */
function classifyByDensity(nps: number): ChartMode {
  if (nps < TIER_BANDS.easy.min) return "easy";
  for (const tier of MODE_ORDER) {
    const band = TIER_BANDS[tier];
    if (nps >= band.min && nps <= band.max) return tier;
  }
  // Above every band's max (only possible past expert.max) → expert with
  // capping. classifyByDensity is invoked before capping happens, so we
  // still report this as expert here.
  return "expert";
}

/**
 * Mapper-name → tier hint. Returns `null` for unrecognized names so the
 * caller can fall back to density-only classification.
 *
 * Order matters: most specific / hardest names first so a chart called
 * "Insane Expert" classifies as expert instead of being shadowed by the
 * earlier "insane" branch.
 */
function classifyDifficultyByName(version: string): ChartMode | null {
  const v = version.toLowerCase();
  if (
    /(expert|extra|\blunatic\b|master|overdose|extreme|edge|deathmoon|\bshd\b)/.test(
      v,
    )
  ) {
    return "expert";
  }
  if (/(insane|\bhyper\b|\bheavy\b|another|crazy)/.test(v)) return "insane";
  if (/(hard|advanced|\bhd\b|rain)/.test(v)) return "hard";
  if (/(normal|basic|medium|\bnm\b|regular|intermediate|platter)/.test(v))
    return "normal";
  if (/(beginner|easy|novice|gentle|noob|lite|casual|cup|salad)/.test(v))
    return "easy";
  return null;
}

/**
 * Pick the bucket a mapper chart actually belongs to. Name is the
 * primary signal but density gets the final say — if the name says one
 * tier and the real nps clearly says another, we trust the math.
 *
 * Examples:
 *   - mapper "Hard" at 6 nps     → name says Hard, density confirms (4.5-7.5) → Hard
 *   - mapper "Hard" at 14 nps    → name says Hard, density says Expert (9.5-22) → Expert
 *   - mapper "[4K Lv.27]" at 8.2 → name unrecognized, density 8.2 ∈ Insane (6.5-10.5) → Insane
 *
 * This is what stops a song with a single mapper-named "Easy" at 14 nps
 * (yes, this happens) from showing up as the player's Easy option.
 */
function assignBucket(version: string, nps: number): ChartMode {
  const named = classifyDifficultyByName(version);
  if (named) {
    const band = TIER_BANDS[named];
    if (nps >= band.min && nps <= band.max) return named;
  }
  return classifyByDensity(nps);
}

/**
 * Snap notes to a beat-grid and dedup by cell. The shape of the grid
 * (how many cells per beat) controls how aggressively the chart is
 * thinned; chord preservation controls whether multiple notes at the
 * same time across different lanes get collapsed into one.
 *
 * `gridDivisor` — cells per beat:
 *    1 → whole beats     (≈ Easy density,        max 1 note / beat)
 *    2 → half beats      (≈ Medium density,      max 2 notes / beat)
 *    3 → triplet 8ths    (intermediate, useful for adaptive Hard)
 *    4 → 16th notes      (≈ Hard density)
 *    6 → triplet 16ths   (intermediate, useful for adaptive Insane)
 *    8 → 32nd notes      (≈ Insane density)
 *
 * `preserveChords`:
 *   - false (default): bucket key = grid cell only. Chord stacks at the
 *     same time collapse to one note. Used for Easy/Medium where the
 *     player should never need more than one finger per moment.
 *   - true: bucket key = `${cell}:${lane}`. Chords survive — vertical
 *     stacks stay intact, only same-lane double-hits within a cell
 *     dedup. Used for Hard/Insane where chord patterns are part of
 *     what makes the tier feel like itself.
 *
 * `maxPerCell` (only meaningful with `preserveChords: true`):
 *   - undefined: no cap. Pure chord-preserve.
 *   - N: at most N notes survive per cell across lanes (first-come on
 *     a per-lane basis, since `bucketCharts` are time-sorted by parser).
 *     Lets us thin chord stacks WITHOUT collapsing every cell to a
 *     single note — the missing rung between full chord-preserve and
 *     full chord-collapse. Critical for synthesizing a tier whose
 *     band sits narrowly between Hard and Expert: pure chord-preserve
 *     leaves all notes (= Expert), pure chord-collapse strips too
 *     much, but `maxPerCell: 2` or `3` reliably shaves chord stacks
 *     without flattening timing variety.
 *
 * Hold notes (sustains) are always preserved unconditionally — losing
 * them on easier tiers would silently drop entire phrases of the song.
 * Their head time is snapped to the nearest cell; duration is kept.
 * Hold heads do NOT count against `maxPerCell` (a sustain anchoring a
 * lane shouldn't displace a downbeat tap in another lane).
 */
function quantizeToGrid(
  notes: Note[],
  bpm: number,
  offsetSec: number,
  gridDivisor: 1 | 2 | 3 | 4 | 6 | 8,
  preserveChords = false,
  maxPerCell?: number,
): Note[] {
  const beatLen = 60 / bpm;
  const cell = beatLen / gridDivisor;
  if (cell <= 0) return notes;

  const isHold = (n: Note) => n.endT != null && n.endT > n.t + 0.05;

  const holds: Note[] = [];
  // Key is a string when chords are preserved (idx + lane) or numeric
  // for the chord-collapse path. Map keeps insertion order so the
  // resulting note array stays roughly in chart order.
  const buckets = new Map<string, Note>();
  // Per-cell lane occupancy — only populated when maxPerCell is in
  // effect. Tracks how many distinct lanes already landed in each cell
  // so we can stop accepting new lanes once the cap is reached.
  const cellLanes =
    preserveChords && maxPerCell != null
      ? new Map<number, Set<number>>()
      : null;

  for (const n of notes) {
    const idx = Math.round((n.t - offsetSec) / cell);
    const snapped = offsetSec + idx * cell;
    if (isHold(n)) {
      const dur = (n.endT as number) - n.t;
      holds.push({
        id: 0,
        t: snapped,
        endT: snapped + dur,
        lane: n.lane,
      });
      continue;
    }
    const key = preserveChords ? `${idx}:${n.lane}` : `${idx}`;
    if (buckets.has(key)) continue;
    if (cellLanes) {
      let lanes = cellLanes.get(idx);
      if (!lanes) {
        lanes = new Set();
        cellLanes.set(idx, lanes);
      }
      // At cap: drop notes for any lane not already accepted in this
      // cell. Notes for already-accepted lanes are no-ops anyway since
      // the `(idx, lane)` key would have hit the `buckets.has(key)`
      // short-circuit above.
      if (lanes.size >= maxPerCell! && !lanes.has(n.lane)) continue;
      lanes.add(n.lane);
    }
    buckets.set(key, { id: 0, t: snapped, lane: n.lane });
  }

  const out: Note[] = [...holds, ...buckets.values()];
  out.sort((a, b) => a.t - b.t);
  out.forEach((n, i) => (n.id = i));
  return out;
}

/**
 * Final-resort thinning that bypasses the beat-grid entirely and just
 * removes a fixed fraction of taps along the chart timeline.
 *
 * Used as the LAST recipe entry for Hard / Insane to guarantee a
 * usable synthesized chart even on awkward sources where every grid
 * recipe either preserves all notes (no chord stacks at finer cells)
 * or strips too aggressively (sparse chart with chord-collapse). The
 * canonical break case: a Hard already lands at /3 chord-preserve,
 * leaving Insane a narrow band of "between Hard and Expert" that no
 * grid divisor naturally hits.
 *
 * Approach: keep all holds (sustains carry phrasing — losing one
 * silently kills part of the song) and Bresenham-step through the
 * sorted taps to drop `(1 - ratio) * count` of them at evenly-spaced
 * indices. This avoids dropping a contiguous burst of notes (which
 * would carve a hole in a single bar) at the cost of slight loss of
 * pattern integrity — acceptable since this only fires when no
 * grid-aligned recipe could thin at all.
 */
function subsampleNotes(notes: Note[], ratio: number): Note[] {
  const isHold = (n: Note) => n.endT != null && n.endT > n.t + 0.05;
  const holds: Note[] = [];
  const taps: Note[] = [];
  for (const n of notes) (isHold(n) ? holds : taps).push(n);
  taps.sort((a, b) => a.t - b.t);

  const targetTaps = Math.max(0, Math.floor(taps.length * ratio));
  const dropCount = taps.length - targetTaps;
  if (dropCount <= 0) {
    // No-op — return a fresh array so the id-rewrite below is honest.
    const out = [...holds, ...taps];
    out.sort((a, b) => a.t - b.t);
    out.forEach((n, i) => (n.id = i));
    return out;
  }

  // Mark `dropCount` indices to skip, evenly distributed.
  const drop = new Set<number>();
  const step = taps.length / dropCount;
  for (let i = 0; i < dropCount; i++) {
    drop.add(Math.min(taps.length - 1, Math.floor((i + 0.5) * step)));
  }
  const kept: Note[] = [];
  for (let i = 0; i < taps.length; i++) {
    if (!drop.has(i)) kept.push(taps[i]);
  }
  const out: Note[] = [...holds, ...kept];
  out.sort((a, b) => a.t - b.t);
  out.forEach((n, i) => (n.id = i));
  return out;
}

/* ------------------------------------------------------------------------- */
/* Public API                                                                */
/* ------------------------------------------------------------------------- */

/**
 * Per-mode availability + note counts for the currently loaded song.
 *
 * `available[mode]` is what the picker reads to enable/disable a button.
 * `noteCounts[mode]` and `npsByMode[mode]` are sized for all 5 tiers so
 * the UI can render a real density readout for any button without extra
 * lookups.
 *
 * Rules (computed in `finalize` / `resolveTier`):
 *   - Mapper-shipped tier → available iff the mapper chart's nps falls
 *     in the tier's band (validated upstream in `assignBucket`).
 *     Special case: mapper Expert above band.max gets thinned down to
 *     band.target so we never surface a 25-nps "Expert".
 *   - Synthesized tier → density-targeted subsample (or beat-grid pass
 *     for Easy/Normal) sourced from the densest mapper chart in the
 *     song. Available iff the result lands inside the tier's band.
 *   - Expert is mapper-only (no chart denser than the source to thin
 *     from). Easy through Insane can always be synthesized when the
 *     source is dense enough to thin into the band.
 */
export interface ModeAvailability {
  noteCounts: Record<ChartMode, number>;
  available: Record<ChartMode, boolean>;
  /**
   * Real notes-per-second for each Syncle bucket on THIS specific song.
   * `0` for unavailable buckets (so a divide-by-zero or "no mapper chart"
   * case never bleeds into the UI as a misleading density).
   */
  npsByMode: Record<ChartMode, number>;
}

export interface LoadSongResult {
  meta: SongMeta;
  notes: Note[];
  source: "osu";
  /** How many notes the original chart had before easy/normal thinning. */
  rawNoteCount: number;
  mode: ChartMode;
  /** Per-mode availability for the difficulty picker. */
  modes: ModeAvailability;
  /**
   * How this song reached the player:
   *   - "local"  → /public asset, fetched from our own origin
   *   - "remote" → unzipped from a public mirror's .osz at runtime
   * The UI uses this to show "fetched from catboy.best" / etc.
   */
  delivery: "local" | "remote";
  /** Set when delivery === "remote" — raw audio bytes for AudioEngine.loadFromBytes. */
  audioBytes?: ArrayBuffer;
  /** Set when delivery === "remote" — opaque dedup key for the audio cache. */
  audioKey?: string;
  /** Set when delivery === "remote" — which mirror served the bytes. */
  mirror?: string;
  /** Set when delivery === "remote" — beatmapset id we pulled. */
  beatmapsetId?: number;
}

/* ------------------------------------------------------------------------- */
/* Local fallback songs                                                      */
/* ------------------------------------------------------------------------- */

/**
 * Songs shipped in /public/songs/ — used as a fallback when every public
 * mirror search API is unreachable. Two is enough for "I can still play
 * something offline / when APIs are down". Add more by dropping a folder
 * under public/songs/<slug>/ with audio.mp3 + chart.osu and listing it here.
 *
 * The runtime never picks from this list as long as a mirror is reachable —
 * the whole point of v0.x is "fresh random song every refresh".
 *
 * Once we add Firestore-backed daily scheduling, this list is what the
 * scheduler will hand out on days where its primary source is empty.
 */
interface LocalSong {
  id: string;
  title: string;
  artist: string;
  year?: number;
  audioUrl: string;
  chartUrl: string;
}

const LOCAL_FALLBACKS: LocalSong[] = [
  {
    id: "credens-justitiam",
    title: "Credens justitiam",
    artist: "Kajiura Yuki",
    year: 2011,
    audioUrl: "/songs/kajiura-yuki-credens-justitiam-extended-edit/audio.mp3",
    chartUrl: "/songs/kajiura-yuki-credens-justitiam-extended-edit/chart.osu",
  },
  {
    id: "ten-sen-men-rittai",
    title: "Ten, Sen, Men, Rittai",
    artist: "Sound piercer",
    audioUrl: "/songs/sound-piercer-ten-sen-men-rittai/audio.mp3",
    chartUrl: "/songs/sound-piercer-ten-sen-men-rittai/chart.osu",
  },
];

/* ------------------------------------------------------------------------- */
/* Session-scoped raw song cache                                             */
/* ------------------------------------------------------------------------- */

/**
 * One parsed chart inside a session — either a mapper-provided difficulty
 * from the .osz, or (for local fallback songs) the single chart that ships.
 */
interface RawChart {
  rawNotes: Note[];
  bpm: number;
  offset: number;
  duration: number;
  /** Mapper's difficulty name (e.g. "[4K Hard]", "Easy"). Empty for local. */
  version: string;
  /** Name density (notes/sec). Used as a classification fallback. */
  nps: number;
}

/**
 * Everything we need to materialize a `LoadSongResult` for any difficulty.
 * Captured ONCE per page session — switching modes never triggers a fresh
 * API roll; we either use a different mapper chart or re-quantize.
 *
 * `bucketCharts` holds at most one mapper chart per bucket (best name match
 * wins ties); `fallbackBase` is the densest chart we have, used as the
 * source for quantization when a bucket has no mapper chart.
 */
interface RawSession {
  bucketCharts: Partial<Record<ChartMode, RawChart>>;
  fallbackBase: RawChart;
  meta: {
    id: string;
    title: string;
    artist: string;
    year?: number;
    audioUrl: string;
    /**
     * Public URL for the beatmap cover art (osu CDN for remote songs;
     * local /public asset for fallback songs that ship one). Used as
     * background art on the homepage card and the in-game StartCard.
     */
    coverUrl?: string;
    /** Beatmapset moderation status — "ranked", "loved", etc. */
    status?: string;
    /** Mapper username — used as a credit line in the UI. */
    creator?: string;
  };
  delivery: "local" | "remote";
  audioBytes?: ArrayBuffer;
  audioKey?: string;
  mirror?: string;
  beatmapsetId?: number;
}

let sessionPromise: Promise<RawSession> | null = null;

/**
 * Pick + load a chart for the current page session.
 *
 *   - First call: rolls a random ranked osu!mania 4K beatmap from a public
 *     mirror, downloads + extracts it. Falls back to a random local song
 *     if every mirror fails.
 *   - Subsequent calls (e.g. switching difficulty): reuse the same raw
 *     song, only re-running quantization for the new mode.
 *   - Pass `force: true` to throw away the cache and roll a fresh song.
 */
export async function loadSong(
  mode: ChartMode = DEFAULT_MODE,
  opts: {
    force?: boolean;
    onProgress?: (msg: string) => void;
    /**
     * When set, bypass the random pool and load this exact
     * beatmapset. Used by the solo "Resume previous run" path so a
     * refreshed player gets THEIR song back instead of a brand-new
     * random roll. Populates the session cache as if the random
     * picker had landed on this set, so subsequent `loadSong()`
     * calls (e.g. the difficulty-toggle re-run) reuse the same
     * session without re-downloading.
     */
    forceBeatmapsetId?: number;
  } = {},
): Promise<LoadSongResult> {
  if (opts.force || opts.forceBeatmapsetId !== undefined) sessionPromise = null;
  if (!sessionPromise) {
    if (opts.forceBeatmapsetId !== undefined) {
      // Seed the session cache from the per-set extract cache so a
      // subsequent difficulty toggle (which calls loadSong again
      // without `forceBeatmapsetId`) reuses this session instead
      // of rolling a new random song. Mirrors the cache-population
      // shape of `pickSession` for remote songs.
      const targetId = opts.forceBeatmapsetId;
      sessionPromise = (async () => {
        const ext = await getExtractedCached(targetId, opts);
        return rawSessionFromExtracted(ext);
      })().catch((err) => {
        sessionPromise = null;
        throw err;
      });
    } else {
      sessionPromise = pickSession(opts.onProgress).catch((err) => {
        // Drop the rejected promise so the next call can retry instead of
        // serving the same error forever (e.g. user fixes their connection).
        sessionPromise = null;
        throw err;
      });
    }
  }
  const session = await sessionPromise;
  return finalize(session, mode);
}

/**
 * Multiplayer entrypoint: load a *specific* beatmapset (chosen by the host
 * server-side) at the requested Syncle difficulty bucket. Bypasses the
 * single-player session cache so two parallel rooms / two refreshes don't
 * stomp on each other's selection.
 *
 * Used by `/multi/[code]` once the server broadcasts `phase:loading`.
 */
export async function loadSongById(
  beatmapsetId: number,
  mode: ChartMode,
  opts: { onProgress?: (msg: string) => void } = {},
): Promise<LoadSongResult> {
  const ext = await getExtractedCached(beatmapsetId, opts);
  const session = rawSessionFromExtracted(ext);
  return finalize(session, mode);
}

/**
 * Fast availability probe: does this beatmapset have charts mapping cleanly
 * to easy / normal / hard buckets in Syncle's scheme?
 *
 * Used by the multiplayer host pane to disable difficulty buttons that the
 * picked song doesn't actually support. Shares the per-set extract cache
 * with `loadSongById` so probing here makes the eventual load free for the
 * host (the .osz only downloads once).
 */
export async function probeSongModes(
  beatmapsetId: number,
  opts: { onProgress?: (msg: string) => void } = {},
): Promise<ModeAvailability> {
  const ext = await getExtractedCached(beatmapsetId, opts);
  const session = rawSessionFromExtracted(ext);
  // `finalize` derives the modes field deterministically from the session;
  // the requested mode doesn't matter, we only read modes off the result.
  return finalize(session, "easy").modes;
}

/**
 * Per-beatmapset extracted-osz cache. Keeps the raw download + chart parse
 * around so probe() and loadSongById() share the same network request.
 *
 * Bounded by `MAX_EXTRACT_CACHE_ENTRIES` to avoid unbounded growth if a
 * curious host clicks through dozens of songs in one session. LRU
 * eviction: oldest insertion order goes first.
 */
const MAX_EXTRACT_CACHE_ENTRIES = 8;
const setExtractCache = new Map<number, Promise<ExtractedSongFull>>();

function getExtractedCached(
  beatmapsetId: number,
  opts: { onProgress?: (msg: string) => void } = {},
): Promise<ExtractedSongFull> {
  const existing = setExtractCache.get(beatmapsetId);
  if (existing) {
    // Re-insert so the entry is treated as "most recently used" for LRU.
    setExtractCache.delete(beatmapsetId);
    setExtractCache.set(beatmapsetId, existing);
    return existing;
  }
  const p = fetchAndExtractAll(beatmapsetId, opts).catch((err) => {
    // Drop on failure so a retry actually re-fetches instead of replaying
    // the same rejected promise forever.
    setExtractCache.delete(beatmapsetId);
    throw err;
  });
  setExtractCache.set(beatmapsetId, p);
  while (setExtractCache.size > MAX_EXTRACT_CACHE_ENTRIES) {
    const oldestKey = setExtractCache.keys().next().value as number | undefined;
    if (oldestKey === undefined) break;
    setExtractCache.delete(oldestKey);
  }
  return p;
}

/* ---- session selection --------------------------------------------------- */

async function pickSession(
  onProgress?: (msg: string) => void,
): Promise<RawSession> {
  // 1) Try the random remote pick path. We attempt a few distinct beatmapsets
  //    in case the first roll lands on something that fails to download or
  //    has no usable 4K diff after all.
  try {
    return await pickRandomRemote(onProgress);
  } catch (err) {
    // Dev-only — these warnings are signal during local debugging
    // (mirror flake, search-api outage, CORS misconfig) but pure
    // noise in production where the local fallback path immediately
    // takes over and the player never notices. NODE_ENV is statically
    // resolved by Next at build time so the entire branch is removed
    // from the production bundle.
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        "[syncle] random remote pick failed across all mirrors, using local fallback:",
        err,
      );
    }
    onProgress?.("Mirrors unreachable, loading local song…");
  }

  // 2) Local fallback — random pick across whatever ships in /public/songs/.
  return pickRandomLocal();
}

const REMOTE_MAX_ATTEMPTS = 4;

async function pickRandomRemote(
  onProgress?: (msg: string) => void,
): Promise<RawSession> {
  const triedSets = new Set<number>();
  let lastErr: unknown;

  for (let attempt = 0; attempt < REMOTE_MAX_ATTEMPTS; attempt++) {
    let pick;
    try {
      pick = await pickRandomManiaBeatmapsetId(onProgress);
    } catch (err) {
      lastErr = err;
      // No point retrying discovery if we already tried once and got an
      // error — search APIs either work or they don't, retrying produces
      // the same failure. Surface immediately so the caller can fall back.
      throw err;
    }
    if (triedSets.has(pick.beatmapsetId)) {
      // Random search rolled the same id twice in a row — try once more.
      continue;
    }
    triedSets.add(pick.beatmapsetId);
    try {
      onProgress?.(
        `Picked beatmapset ${pick.beatmapsetId}${
          pick.title ? ` (${pick.artist} — ${pick.title})` : ""
        }, downloading…`,
      );
      const extracted = await fetchAndExtractAll(pick.beatmapsetId, { onProgress });
      return rawSessionFromExtracted(extracted, {
        status: pick.status,
        creator: pick.creator,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Dev-only — same rationale as the outer mirror-failed warn.
      // The retry loop itself decides whether to surface anything to
      // the player; the per-attempt detail only helps when debugging
      // why a *specific* mirror keeps rejecting a download.
      if (process.env.NODE_ENV !== "production") {
        console.warn(
          `[syncle] beatmapset ${pick.beatmapsetId} failed (attempt ${attempt + 1}/${REMOTE_MAX_ATTEMPTS}):`,
          msg,
        );
      }
      lastErr = err;
    }
  }

  throw new Error(
    `Could not download a usable random beatmap after ${triedSets.size} attempt(s): ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

function rawSessionFromExtracted(
  ext: ExtractedSongFull,
  apiMeta: { status?: string; creator?: string } = {},
): RawSession {
  // Parse every chart in the .osz; toss any that fail to parse as 4K mania.
  const parsedCharts: Array<{ chart: ExtractedChart; raw: RawChart }> = [];
  for (const c of ext.charts) {
    const p = parseOsu(c.chartText);
    if (!p) continue;
    const nps = p.duration > 0 ? p.notes.length / p.duration : 0;
    parsedCharts.push({
      chart: c,
      raw: {
        rawNotes: p.notes,
        bpm: p.bpm,
        offset: p.offset,
        duration: p.duration,
        version: c.meta.version,
        nps,
      },
    });
  }
  if (parsedCharts.length === 0) {
    throw new Error(
      `Beatmapset ${ext.beatmapsetId} has no parseable 4K mania charts`,
    );
  }

  // Bucket each chart by name+density (see `assignBucket`). When two
  // mapper charts collide in the same bucket we tie-break by density:
  //   - Easy / Normal: prefer LOWER nps (more chill, closer to band min)
  //   - Hard / Insane / Expert: prefer HIGHER nps (more challenge, closer
  //     to band max) — but Expert above its band max gets capped at
  //     synthesis time, not here.
  const bucketCharts: Partial<Record<ChartMode, RawChart>> = {};
  for (const { raw } of parsedCharts) {
    const bucket = assignBucket(raw.version, raw.nps);
    const existing = bucketCharts[bucket];
    const preferLow = bucket === "easy" || bucket === "normal";
    const better =
      existing === undefined ||
      (preferLow ? raw.nps < existing.nps : raw.nps > existing.nps);
    if (better) bucketCharts[bucket] = raw;
  }

  // Densest chart in the set, regardless of bucket — used as the source
  // when we need to quantize down for an empty bucket.
  const fallbackBase = parsedCharts.reduce(
    (best, cur) => (cur.raw.nps > best.nps ? cur.raw : best),
    parsedCharts[0].raw,
  );

  // Use the fallback (densest) chart's name for the song id, so the daily
  // best key is stable across mode switches within the same beatmapset.
  const id = `osu-${ext.beatmapsetId}-${slugify(fallbackBase.version)}`;
  const audioKey = `osu:${ext.beatmapsetId}`;

  return {
    bucketCharts,
    fallbackBase,
    meta: {
      id,
      title: parsedCharts[0].chart.meta.title,
      artist: parsedCharts[0].chart.meta.artist,
      audioUrl: "",
      // osu CDN serves a few size variants per beatmapset under
      // /covers/. `cover@2x.jpg` is ~1920×360, big enough to look crisp
      // when used as a card background even on retina screens. Public,
      // no-auth, aggressively cached.
      coverUrl: `https://assets.ppy.sh/beatmaps/${ext.beatmapsetId}/covers/cover@2x.jpg`,
      status: apiMeta.status,
      creator: apiMeta.creator,
    },
    delivery: "remote",
    audioBytes: ext.audioBytes,
    audioKey,
    mirror: ext.mirror,
    beatmapsetId: ext.beatmapsetId,
  };
}

/* ---- local fallback ------------------------------------------------------ */

async function pickRandomLocal(): Promise<RawSession> {
  if (LOCAL_FALLBACKS.length === 0) {
    throw new Error("No local fallback songs configured");
  }
  const song =
    LOCAL_FALLBACKS[Math.floor(Math.random() * LOCAL_FALLBACKS.length)];

  const res = await fetch(song.chartUrl, { cache: "force-cache" });
  if (!res.ok) {
    throw new Error(
      `Local fallback chart fetch failed for "${song.id}": HTTP ${res.status} (${song.chartUrl})`,
    );
  }
  const text = await res.text();
  const parsed = parseOsu(text);
  if (!parsed) {
    throw new Error(
      `Local fallback chart "${song.id}" is not a valid 4K mania beatmap`,
    );
  }
  // Local songs ship a single chart — we don't have mapper-made variants,
  // so all three Syncle modes derive from this one chart via quantization.
  // The bucketCharts map stays empty; finalize() will use fallbackBase.
  const nps = parsed.duration > 0 ? parsed.notes.length / parsed.duration : 0;
  const fallbackBase: RawChart = {
    rawNotes: parsed.notes,
    bpm: parsed.bpm,
    offset: parsed.offset,
    duration: parsed.duration,
    version: "",
    nps,
  };
  return {
    bucketCharts: {},
    fallbackBase,
    meta: {
      id: song.id,
      title: song.title,
      artist: song.artist,
      year: song.year,
      audioUrl: song.audioUrl,
    },
    delivery: "local",
  };
}

/* ---- finalize (per-mode quantization) ------------------------------------ */

/**
 * Per-tier resolution result. Tracks not just the notes but also which
 * mapper chart we sourced them from, so the HUD can show the player a
 * truthful "raw N notes" readout — i.e. the size of the chart we
 * actually thinned, not the densest chart in the .osz.
 */
interface ResolvedTier {
  notes: Note[];
  count: number;
  available: boolean;
  /**
   * The mapper chart that produced this tier's notes, either directly
   * (mapper-shipped) or as the source we quantized from. `null` only
   * for unavailable tiers.
   */
  source: RawChart | null;
  /** True when `source.rawNotes === notes` (no quantization applied). */
  mapperShipped: boolean;
}

/**
 * Densest mapper chart in the song, or the fallback base if no buckets
 * are populated. This is the canonical source for synthesizing every
 * non-mapper tier — "thin the highest-fidelity reference" gives more
 * predictable density bands than "thin the nearest above" (which had
 * the perverse outcome where mapper-shipping a sparse Insane would
 * cause Hard to be synthesized from THAT instead of the dense Expert,
 * producing a chart that didn't fit the Hard band at all).
 *
 * Subsampling is deterministic and beat-agnostic, so sourcing every
 * synthesized tier from one canonical chart gives the player a
 * consistent "feel chain": the patterns they see at Easy are the same
 * shapes they'll see at Expert, just sparser.
 */
function densestSource(
  buckets: Partial<Record<ChartMode, RawChart>>,
  fallback: RawChart,
): RawChart {
  let best: RawChart = fallback;
  for (const tier of MODE_ORDER) {
    const c = buckets[tier];
    if (c && c.nps > best.nps) best = c;
  }
  return best;
}

/**
 * Resolve every Syncle tier to concrete notes + availability + density,
 * then return the result for the requested mode.
 *
 * The new model: every tier owns a calibrated nps band (see
 * `TIER_BANDS`) and `resolveTier` either delivers a chart whose density
 * lands inside that band or marks the tier unavailable. There's no
 * relative-ordering check between tiers anymore — bands are absolute,
 * which is why a Hard always feels like a Hard regardless of how dense
 * the source song happened to be.
 *
 * Per-tier strategy:
 *   - mapper-shipped chart in the bucket → use it as-is (Expert above
 *     band.max gets thinned down to band.target)
 *   - else → subsample the densest mapper chart in the song to land at
 *     band.target nps (Easy/Normal try a beat-grid pass first for
 *     musicality and fall back to subsample if the grid result is
 *     out of band)
 *   - if no source can produce a chart in band → tier disabled
 *
 * The result: the picker shows you exactly the tiers that are honest
 * representations of their label, never a "Hard" that's secretly Expert
 * or an "Easy" with 14 nps streams.
 */
function finalize(session: RawSession, mode: ChartMode): LoadSongResult {
  const buckets = session.bucketCharts;
  const base = session.fallbackBase;
  const source = densestSource(buckets, base);

  const tiers: Record<ChartMode, ResolvedTier> = {
    easy: emptyTier(),
    normal: emptyTier(),
    hard: emptyTier(),
    insane: emptyTier(),
    expert: emptyTier(),
  };

  for (const tier of MODE_ORDER) {
    tiers[tier] = resolveTier(tier, buckets, source);
  }

  const requested = tiers[mode];
  // Resolution map from mode → which chart we use for audio metadata.
  // Mapper-shipped tiers use their own mapper chart; synthesized tiers
  // ride on their source chart's bpm/offset/duration (we didn't shift
  // any of that, just thinned the note set).
  const chartForMode = requested.source ?? base;

  const safeDiv = (n: number, d: number) => (d > 0 ? n / d : 0);
  const tierDuration = (t: ChartMode) =>
    (tiers[t].source ?? base).duration;

  const modes: ModeAvailability = {
    noteCounts: {
      easy: tiers.easy.count,
      normal: tiers.normal.count,
      hard: tiers.hard.count,
      insane: tiers.insane.count,
      expert: tiers.expert.count,
    },
    available: {
      easy: tiers.easy.available,
      normal: tiers.normal.available,
      hard: tiers.hard.available,
      insane: tiers.insane.available,
      expert: tiers.expert.available,
    },
    // Zero out NPS for unavailable tiers so the UI doesn't show a stale
    // density for a button it can't even click.
    npsByMode: {
      easy: tiers.easy.available
        ? safeDiv(tiers.easy.count, tierDuration("easy"))
        : 0,
      normal: tiers.normal.available
        ? safeDiv(tiers.normal.count, tierDuration("normal"))
        : 0,
      hard: tiers.hard.available
        ? safeDiv(tiers.hard.count, tierDuration("hard"))
        : 0,
      insane: tiers.insane.available
        ? safeDiv(tiers.insane.count, tierDuration("insane"))
        : 0,
      expert: tiers.expert.available
        ? safeDiv(tiers.expert.count, tierDuration("expert"))
        : 0,
    },
  };

  const meta: SongMeta = {
    id: session.meta.id,
    title: session.meta.title,
    artist: session.meta.artist,
    year: session.meta.year,
    bpm: chartForMode.bpm,
    offset: chartForMode.offset,
    duration: chartForMode.duration,
    audioUrl: session.meta.audioUrl,
    difficulty: mode,
    coverUrl: session.meta.coverUrl,
    status: session.meta.status,
    creator: session.meta.creator,
  };
  return {
    meta,
    notes: requested.notes,
    source: "osu",
    // `rawNoteCount` is the count of the chart we sourced this tier
    // FROM — for mapper-shipped tiers that equals the tier's own count
    // (so the "raw N" badge naturally hides), for synthesized tiers it
    // surfaces the size of the parent mapper chart we thinned. Falls
    // back to base only for unavailable tiers (which the caller
    // shouldn't be requesting in the first place).
    rawNoteCount: (requested.source ?? base).rawNotes.length,
    mode,
    modes,
    delivery: session.delivery,
    audioBytes: session.audioBytes,
    audioKey: session.audioKey,
    mirror: session.mirror,
    beatmapsetId: session.beatmapsetId,
  };
}

function emptyTier(): ResolvedTier {
  return {
    notes: [],
    count: 0,
    available: false,
    source: null,
    mapperShipped: false,
  };
}

/**
 * Resolve a single tier against its density band.
 *
 * Three paths, in order:
 *
 *   1. Mapper-shipped (`buckets[tier]` is set). The chart already passed
 *      band validation in `assignBucket`, so we just hand it back. Special
 *      case: Expert above its band.max gets thinned to band.target — this
 *      is what stops an absurd 25-nps mapper "Lunatic" from surfacing as
 *      a 25-nps "Expert" button. The original count survives in
 *      `source.rawNotes.length`, so the HUD's "raw N" badge still tells
 *      the truth about what the chart was natively.
 *
 *   2. Synthesized via beat-grid (Easy / Normal only). We try a /1 or /2
 *      grid pass first because it snaps notes to whole/half beats — gives
 *      players the musical "tap on the downbeat" feel they expect at
 *      easier tiers. If the grid result lands in band, we use it. If
 *      not (uncommon BPMs, sparse sources), we fall through to step 3.
 *
 *   3. Synthesized via subsample. Computes the exact ratio needed to land
 *      `result.length / source.duration` near `band.target`, accounting
 *      for hold notes (always preserved, so we only thin taps). Holds
 *      contribute to density on their own — if the source's holds alone
 *      already exceed band.max nps we can't synthesize this tier without
 *      dropping sustains, which we refuse to do.
 *
 * If every path fails to produce a chart inside `[band.min, band.max]`,
 * the tier is disabled and the picker shows it greyed-out.
 *
 * Why no synthesis for Expert: Expert is the densest tier by definition,
 * and we can't add notes to a source — we can only thin. So Expert
 * requires either a mapper Expert (the common case) or a re-bucketed
 * mapper chart whose density landed in the Expert band.
 */
function resolveTier(
  tier: ChartMode,
  buckets: Partial<Record<ChartMode, RawChart>>,
  source: RawChart,
): ResolvedTier {
  const band = TIER_BANDS[tier];

  // 1) Mapper-shipped — assignment already validated the band, except for
  //    Expert which has an upper cap that we apply here.
  const mapper = buckets[tier];
  if (mapper) {
    if (tier === "expert" && mapper.nps > band.max) {
      const thinned = subsampleToTargetNps(mapper, band.target);
      // Even after capping, a degenerate source (huge holds, no taps)
      // might miss the band. Validate before reporting available.
      if (thinned && inBand(thinned.length, mapper.duration, band)) {
        return {
          notes: thinned,
          count: thinned.length,
          available: true,
          source: mapper,
          mapperShipped: false,
        };
      }
      return emptyTier();
    }
    return {
      notes: mapper.rawNotes,
      count: mapper.rawNotes.length,
      available: true,
      source: mapper,
      mapperShipped: true,
    };
  }

  // 2) Synthesize — only if the source can plausibly thin DOWN to the
  //    band. A source sparser than the band's min can never reach this
  //    tier (we'd need to invent notes), and Expert can't be synthesized
  //    at all (nothing denser to thin from).
  if (tier === "expert") return emptyTier();
  if (source.nps < band.min) return emptyTier();

  // 2a) Beat-grid passes for Easy / Normal — snaps notes to musical
  //     beats. We try MULTIPLE divisors and use the first that lands in
  //     band, instead of locking to a single divisor that may overshoot
  //     on high-BPM sources (a /1 grid at BPM 280 gives 4.7 nps, way
  //     above Easy's 3.5 max). The order biases toward the coarsest
  //     grid that fits, which gives the most musical-feeling result.
  if (tier === "easy" || tier === "normal") {
    const divisors: Array<1 | 2 | 3 | 4> =
      tier === "easy" ? [1, 2, 3] : [2, 3, 4];
    for (const div of divisors) {
      const grid = quantizeToGrid(
        source.rawNotes,
        source.bpm,
        source.offset,
        div,
        false,
      );
      if (inBand(grid.length, source.duration, band)) {
        return {
          notes: grid,
          count: grid.length,
          available: true,
          source,
          mapperShipped: false,
        };
      }
    }
    // Fall through to subsample.
  }

  // 2b) Subsample pass — precise density targeting via tap-fraction
  //     math. Tries the band target first (the calibrated "feels like
  //     this tier" density) and then walks a few candidate targets
  //     inside the band so we don't disable a tier just because the
  //     calibrated target landed a hair outside on this particular
  //     source. Holds are preserved across all of these.
  const subTargets: number[] = [
    band.target,
    (band.min + band.target) / 2,
    (band.target + band.max) / 2,
    band.min,
    band.max,
  ];
  for (const target of subTargets) {
    const sub = subsampleToTargetNps(source, target);
    if (sub && inBand(sub.length, source.duration, band)) {
      return {
        notes: sub,
        count: sub.length,
        available: true,
        source,
        mapperShipped: false,
      };
    }
  }

  // 2c) Hold-thinning fallback for Easy / Normal. Fires when the source's
  //     sustains are so dense they alone exceed the tier's band.max
  //     (think Expert hold-spam → Easy: holds at 5 nps, Easy max 3.5).
  //     Without this fallback, Easy and Medium would simply be DISABLED
  //     on those songs, which is exactly the failure mode the user hit
  //     ("u quantizied the others, but u didnt do the easy and medium
  //     modes"). We only allow this for Easy/Normal because losing some
  //     sustains is acceptable on the simplification-friendly tiers and
  //     unacceptable on the Hard-and-up tiers where holds carry chart
  //     identity.
  if (tier === "easy" || tier === "normal") {
    for (const target of subTargets) {
      const thinned = thinHoldsAndSubsampleToTargetNps(source, target);
      if (thinned && inBand(thinned.length, source.duration, band)) {
        return {
          notes: thinned,
          count: thinned.length,
          available: true,
          source,
          mapperShipped: false,
        };
      }
    }
  }

  return emptyTier();
}

/**
 * Subsample `chart` so its resulting density lands at approximately
 * `targetNps`. Holds are kept unconditionally (losing one would silently
 * drop a phrase of the song), so we compute the fraction of *taps* to
 * keep in order to hit the total target count.
 *
 * Returns `null` if the source has no taps at all (rare — short pure-hold
 * sustain charts) since we have nothing to thin.
 *
 * Note: when `holdCount/duration > targetNps`, the result will simply be
 * "all holds, zero taps" and the resulting density still exceeds target.
 * That's intentional here — phrasing-preservation is the contract of this
 * helper. Tiers that need to dip BELOW the holds-floor (e.g. Easy on a
 * sustain-heavy Expert source) use `thinHoldsAndSubsampleToTargetNps`
 * instead, which is allowed to drop sustains as a last resort.
 */
function subsampleToTargetNps(
  chart: RawChart,
  targetNps: number,
): Note[] | null {
  let tapCount = 0;
  for (const n of chart.rawNotes) {
    const isHold = n.endT != null && n.endT > n.t + 0.05;
    if (!isHold) tapCount++;
  }
  if (tapCount === 0) return null;
  const holdCount = chart.rawNotes.length - tapCount;
  const targetTotal = Math.round(targetNps * chart.duration);
  const targetTaps = Math.max(0, targetTotal - holdCount);
  const ratio = Math.min(1.0, targetTaps / tapCount);
  return subsampleNotes(chart.rawNotes, ratio);
}

/**
 * Hold-permissive variant of {@link subsampleToTargetNps} — thins BOTH
 * holds and taps to hit `targetNps`. Used as a last-resort fallback for
 * Easy/Medium synthesis when the source is so hold-heavy that
 * `holdCount/duration` alone already exceeds the tier's band.max.
 *
 * Why this is OK to do (despite our usual "never drop a sustain" rule):
 *
 *   - The hold-preserving subsample only fails on charts where sustains
 *     are SO dense they form streams in their own right (think Expert
 *     hold-spam patterns at 5+ nps). On those charts the sustains are no
 *     longer "phrasing markers" — they're the chart's main density. A
 *     player asking for Easy literally cannot play an Easy unless we
 *     thin them.
 *
 *   - Refusing to thin would mean the song shows Easy and Medium as
 *     unavailable, which is what the user actually complained about
 *     ("u quantizied the others, but u didnt do the easy and medium
 *     modes"). Silent loss of some holds is strictly better than a
 *     dead button.
 *
 * Strategy:
 *   1. Decide how many holds to keep so they contribute at most ~70% of
 *      the target density (leaves headroom for some taps to land on
 *      downbeats — a pure-holds Easy feels nothing like an Easy).
 *   2. Bresenham-thin holds along the timeline to that count, preserving
 *      time distribution rather than just slicing off the tail.
 *   3. Top up to `targetTotal` with evenly-thinned taps.
 *   4. Sort + reassign ids before returning.
 *
 * Returns `null` only on degenerate inputs (zero notes / zero duration).
 */
function thinHoldsAndSubsampleToTargetNps(
  chart: RawChart,
  targetNps: number,
): Note[] | null {
  if (chart.rawNotes.length === 0 || chart.duration <= 0) return null;
  const isHold = (n: Note) => n.endT != null && n.endT > n.t + 0.05;
  const holds: Note[] = [];
  const taps: Note[] = [];
  for (const n of chart.rawNotes) (isHold(n) ? holds : taps).push(n);
  holds.sort((a, b) => a.t - b.t);
  taps.sort((a, b) => a.t - b.t);

  const targetTotal = Math.max(0, Math.round(targetNps * chart.duration));
  if (targetTotal === 0) return null;

  // Cap the hold quota at 70% of total target — keeps room for a real
  // tap layer so the synthesized chart still feels like a tap-driven
  // tier instead of a sustain-only soup.
  const holdQuota = Math.min(holds.length, Math.floor(targetTotal * 0.7));

  // Bresenham-keep `holdQuota` holds out of `holds.length`, evenly
  // distributed across time so we don't carve a gap in any one section.
  const keptHolds: Note[] = [];
  if (holds.length === 0) {
    // No holds in source — fall back to plain tap subsample.
  } else if (holdQuota >= holds.length) {
    keptHolds.push(...holds);
  } else if (holdQuota > 0) {
    const step = holds.length / holdQuota;
    for (let i = 0; i < holdQuota; i++) {
      const idx = Math.min(holds.length - 1, Math.floor((i + 0.5) * step));
      keptHolds.push(holds[idx]);
    }
  }

  // Top up to `targetTotal` with thinned taps.
  const remainingForTaps = Math.max(0, targetTotal - keptHolds.length);
  const keptTaps: Note[] = [];
  if (remainingForTaps > 0 && taps.length > 0) {
    const tapKeep = Math.min(taps.length, remainingForTaps);
    if (tapKeep >= taps.length) {
      keptTaps.push(...taps);
    } else {
      const step = taps.length / tapKeep;
      for (let i = 0; i < tapKeep; i++) {
        const idx = Math.min(taps.length - 1, Math.floor((i + 0.5) * step));
        keptTaps.push(taps[idx]);
      }
    }
  }

  const out: Note[] = [...keptHolds, ...keptTaps];
  if (out.length === 0) return null;
  out.sort((a, b) => a.t - b.t);
  out.forEach((n, i) => (n.id = i));
  return out;
}

/** True iff `count` notes over `duration` seconds lands inside `band`. */
function inBand(
  count: number,
  duration: number,
  band: { min: number; max: number },
): boolean {
  if (duration <= 0) return false;
  const nps = count / duration;
  return nps >= band.min && nps <= band.max;
}

/* ---- helpers ------------------------------------------------------------- */

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "x"
  );
}

/**
 * Warm the browser HTTP cache for a song's audio bytes without decoding.
 * Only useful for local-delivery songs (URLs); remote-delivery songs go
 * through fetchAndExtract which doesn't hit our origin at all.
 */
const audioPrefetched = new Set<string>();
export function prefetchAudio(url: string): void {
  if (!url || audioPrefetched.has(url)) return;
  audioPrefetched.add(url);
  fetch(url, { cache: "force-cache" }).catch(() => {
    audioPrefetched.delete(url);
  });
}
