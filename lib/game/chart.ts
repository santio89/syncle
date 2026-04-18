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
 * Resolution order per mode (best to worst source):
 *   1. A mapper-provided chart for this bucket — every .osz has 1–7
 *      hand-crafted difficulties; we classify each by its name (e.g.
 *      "[4K Insane]" → insane) and bucket the best fit. This is the
 *      authentic experience the mapper designed.
 *   2. Quantization fallback (only for the three EASIER tiers, since you
 *      can THIN a dense chart but you can't INVENT extra notes for a
 *      higher tier than the mapper provided):
 *        easy   → quantize the densest chart to whole beats
 *        normal → quantize the densest chart to half-beats
 *        hard   → mapper "Hard" if present, else the densest chart as-is
 *        insane → mapper-only; otherwise unavailable
 *        expert → mapper-only; otherwise unavailable
 *      Hold notes are preserved across quantization (head snapped, length
 *      kept) so sustains never disappear.
 *
 * A mode is marked unavailable in `ModeAvailability` and disabled in the
 * UI when:
 *   - it's insane/expert and the song has no mapper chart for it; or
 *   - it's easy/normal and quantization didn't actually thin the next
 *     denser bucket (so the buttons would play an identical chart, which
 *     is misleading).
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
 * Hold notes (sustains) are always preserved unconditionally — losing
 * them on easier tiers would silently drop entire phrases of the song.
 * Their head time is snapped to the nearest cell; duration is kept.
 */
function quantizeToGrid(
  notes: Note[],
  bpm: number,
  offsetSec: number,
  gridDivisor: 1 | 2 | 3 | 4 | 6 | 8,
  preserveChords = false,
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
    if (!buckets.has(key)) {
      buckets.set(key, { id: 0, t: snapped, lane: n.lane });
    }
  }

  const out: Note[] = [...holds, ...buckets.values()];
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
 * Rules (computed in `finalize`):
 *   - Mapper-shipped tier → always available, count = mapper chart size
 *   - Synthesized tier → quantized from the *nearest mapper-shipped tier
 *     above* (never from another synthesized tier — that would compound
 *     approximation errors). Available iff the quantized count lands
 *     strictly between the previous available tier's count and the
 *     source mapper chart's count.
 *   - Expert is mapper-only (no tier above to source from)
 *
 * Per-tier divisor recipes (see `RECIPES` below): easy and normal use
 * a single coarse-grid chord-collapse; hard and insane try chord-
 * preserve at multiple divisors first, falling back to chord-collapse
 * on sparse sources where chord-preserve doesn't thin enough to clear
 * the strict "between neighbors" availability check.
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
  opts: { force?: boolean; onProgress?: (msg: string) => void } = {},
): Promise<LoadSongResult> {
  if (opts.force) sessionPromise = null;
  if (!sessionPromise) {
    sessionPromise = pickSession(opts.onProgress).catch((err) => {
      // Drop the rejected promise so the next call can retry instead of
      // serving the same error forever (e.g. user fixes their connection).
      sessionPromise = null;
      throw err;
    });
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
    console.warn(
      "[syncle] random remote pick failed across all mirrors, using local fallback:",
      err,
    );
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
      console.warn(
        `[syncle] beatmapset ${pick.beatmapsetId} failed (attempt ${attempt + 1}/${REMOTE_MAX_ATTEMPTS}):`,
        msg,
      );
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

  // Bucket each chart by its difficulty name; tie-break by note density so
  // a "Hard" chart that's actually easier than another "Hard" doesn't
  // displace the bigger one as the canonical hard pick.
  const bucketCharts: Partial<Record<ChartMode, RawChart>> = {};
  const bucketNps: Partial<Record<ChartMode, number>> = {};
  for (const { raw } of parsedCharts) {
    const bucket = classifyDifficulty(raw.version, raw.nps);
    const existing = bucketNps[bucket];
    // For "easy"/"normal" prefer LOWER nps within the bucket (more chill);
    // for "hard" prefer HIGHER nps (more notes = real challenge).
    const better =
      existing === undefined ||
      (bucket === "hard" ? raw.nps > existing : raw.nps < existing);
    if (better) {
      bucketCharts[bucket] = raw;
      bucketNps[bucket] = raw.nps;
    }
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

/* ---- difficulty classification ------------------------------------------ */

/**
 * osu!mania difficulty naming is a wild west — mappers use anything from
 * "Easy" to "[4K Lunatic]" to "yang's Hyper". We classify by name first
 * (most reliable), then fall back to note density.
 *
 * The 5-tier mapping mirrors osu!'s own difficulty hierarchy:
 *   easy    → Easy / Beginner / Novice / Cup / Salad / Gentle / Noob
 *   normal  → Normal / Basic / Medium / Regular / Platter / Intermediate
 *   hard    → Hard / Advanced / Rain
 *   insane  → Insane / Hyper / Heavy / Another / Crazy
 *   expert  → Expert / Extra / Master / Lunatic / Overdose / Extreme /
 *             Edge / Deathmoon / SHD
 */
function classifyDifficulty(version: string, nps: number): ChartMode {
  const v = version.toLowerCase();

  // Order matters: most specific / hardest names first so a chart called
  // "Insane Expert" classifies as expert instead of being shadowed by the
  // earlier "insane" branch.
  if (
    /(expert|extra|\blunatic\b|master|overdose|extreme|edge|deathmoon|\bshd\b)/.test(
      v,
    )
  ) {
    return "expert";
  }
  if (/(insane|\bhyper\b|\bheavy\b|another|crazy)/.test(v)) {
    return "insane";
  }
  if (/(hard|advanced|\bhd\b|rain)/.test(v)) {
    return "hard";
  }
  if (/(normal|basic|medium|\bnm\b|regular|intermediate|platter)/.test(v)) {
    return "normal";
  }
  if (/(beginner|easy|novice|gentle|noob|lite|casual|cup|salad)/.test(v)) {
    return "easy";
  }

  // Unknown name → bucket by raw note density. NPS thresholds are
  // calibrated against the typical 4K density spread.
  if (nps < 1.8) return "easy";
  if (nps < 3.2) return "normal";
  if (nps < 5.0) return "hard";
  if (nps < 7.0) return "insane";
  return "expert";
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
 * Per-tier quantization recipe used when no mapper chart fills the
 * bucket. Each recipe is a list of `(divisor, preserveChords)` attempts
 * tried in order — `resolveTier` walks the list and returns the first
 * attempt whose note count lands strictly between the previous
 * available tier and the source.
 *
 * Why a list instead of a single divisor:
 *
 *   1. Different sources sit on different native grids (a "Lunatic"
 *      mapper chart might be at /16 spacing while a sparse "Insane"
 *      sits at /4). A fixed divisor that thins one wouldn't thin the
 *      other.
 *
 *   2. Chord-preserve thinning *only* removes notes that collide on
 *      the same `(cell, lane)`. For dense sources (heavy stream / jack
 *      patterns) that's plenty. For sparse sources where notes are
 *      already spread across distinct cells, NO chord-preserve divisor
 *      thins anything — result count == source count, tier disabled.
 *
 *      Solution: append chord-COLLAPSE attempts after the chord-preserve
 *      ones. Chord-collapse always thins on any source with chord
 *      stacks (collapses them to single notes regardless of grid). Tier
 *      feel suffers slightly (Hard with no chord patterns is more like
 *      a fast Medium) but the picker stays populated, which the player
 *      cares about more than the editorial nuance.
 *
 * Recipe attempts are ordered "least destructive first":
 *   - Try chord-preserve at coarsest divisor → finest divisor first,
 *     since coarsest produces the most thinning when it works at all.
 *   - Only then drop chord preservation as a last resort.
 */
type Recipe = {
  divisor: 1 | 2 | 3 | 4 | 6 | 8;
  preserveChords: boolean;
};
const RECIPES: Record<Exclude<ChartMode, "expert">, Recipe[]> = {
  // Easy / Normal use a single fixed coarse grid + chord-collapse.
  // No fallbacks needed: chord-collapse at /1 or /2 produces such
  // aggressive thinning that even a single-note-no-chord source
  // (extremely rare) drops to ~max-1-note-per-cell density.
  easy:   [{ divisor: 1, preserveChords: false }],
  normal: [{ divisor: 2, preserveChords: false }],
  hard: [
    { divisor: 3, preserveChords: true },
    { divisor: 4, preserveChords: true },
    { divisor: 6, preserveChords: true },
    // Chord-collapse fallbacks: kicked in for sparse Expert sources
    // (8-10 nps) where chord-preserve doesn't find collisions.
    { divisor: 4, preserveChords: false },
    { divisor: 6, preserveChords: false },
  ],
  insane: [
    { divisor: 4, preserveChords: true },
    { divisor: 6, preserveChords: true },
    { divisor: 8, preserveChords: true },
    { divisor: 6, preserveChords: false },
    { divisor: 8, preserveChords: false },
  ],
};

/**
 * Find the nearest mapper-shipped chart at a tier strictly *higher*
 * than `tier`. Returns `null` if every tier above `tier` is empty. We
 * deliberately skip synthesized neighbors — only mapper-crafted charts
 * are valid quantization sources, otherwise easier tiers would compound
 * errors from the synthesis chain ("easy from a normal that was itself
 * thinned from a hard that was thinned from an expert" → garbage).
 */
function nearestMapperAbove(
  tier: ChartMode,
  bucketCharts: Partial<Record<ChartMode, RawChart>>,
): RawChart | null {
  const tierIdx = MODE_ORDER.indexOf(tier);
  for (let i = tierIdx + 1; i < MODE_ORDER.length; i++) {
    const c = bucketCharts[MODE_ORDER[i]];
    if (c) return c;
  }
  return null;
}

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
 * Resolve every Syncle tier to concrete notes + availability + density,
 * then return the result for the requested mode.
 *
 * Resolution order is ASCENDING (easy → expert) because each tier's
 * availability check needs the count of the previous available tier as
 * its lower bound. The recipe-driven model below makes the per-tier
 * source choice explicit:
 *
 *   easy   → mapper, else /1 chord-collapse from nearest mapper above
 *   normal → mapper, else /2 chord-collapse from nearest mapper above
 *   hard   → mapper, else adaptive (/3→/4→/6) chord-preserve from
 *            nearest mapper above (typically Insane or Expert)
 *   insane → mapper, else adaptive (/4→/6→/8) chord-preserve from
 *            nearest mapper above (typically Expert)
 *   expert → mapper-only (no mapper tier above to source from)
 *
 * The "nearest mapper above" rule is what makes the synthesized charts
 * musical: a Hard thinned from a hand-crafted Insane preserves the
 * Insane mapper's editorial choices, whereas a Hard thinned directly
 * from Expert is a much rougher approximation. Smaller density steps
 * produce better patterns.
 *
 * A tier is *available* iff there's either a mapper-shipped chart OR a
 * quantization that landed strictly between (a) the previous available
 * tier's count and (b) the source chart's count. Both bounds matter:
 * matching the previous tier's count would be a redundant button;
 * matching the source's count would just be replaying the source under
 * a different label.
 */
function finalize(session: RawSession, mode: ChartMode): LoadSongResult {
  const buckets = session.bucketCharts;
  const base = session.fallbackBase;

  const tiers: Record<ChartMode, ResolvedTier> = {
    easy: emptyTier(),
    normal: emptyTier(),
    hard: emptyTier(),
    insane: emptyTier(),
    expert: emptyTier(),
  };

  // Walk tiers from easiest to hardest so each one knows the count of
  // the previous *available* tier and can use it as the lower bound for
  // its "between" check.
  let prevAvailableCount = 0;
  for (const tier of MODE_ORDER) {
    tiers[tier] = resolveTier(tier, buckets, prevAvailableCount);
    if (tiers[tier].available) prevAvailableCount = tiers[tier].count;
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
 * Resolve a single tier. `prevAvailableCount` is the note count of the
 * nearest available tier below — used as the strict lower bound for
 * the "between two anchors" availability check on synthesized tiers.
 *
 * Mapper-shipped tiers always count as available regardless of their
 * relationship to neighbors (the mapper said this is a distinct diff,
 * we trust them). Synthesized tiers must land in the open interval
 * `(prevAvailableCount, sourceCount)` to count.
 */
function resolveTier(
  tier: ChartMode,
  buckets: Partial<Record<ChartMode, RawChart>>,
  prevAvailableCount: number,
): ResolvedTier {
  const mapper = buckets[tier];
  if (mapper) {
    return {
      notes: mapper.rawNotes,
      count: mapper.rawNotes.length,
      available: true,
      source: mapper,
      mapperShipped: true,
    };
  }

  // Expert has no recipe — there's nothing denser in the .osz to
  // thin from, so synthesizing it would just relabel an existing chart.
  if (tier === "expert") return emptyTier();

  const source = nearestMapperAbove(tier, buckets);
  if (!source) return emptyTier();

  const recipes = RECIPES[tier];
  const sourceCount = source.rawNotes.length;
  for (const { divisor, preserveChords } of recipes) {
    const result = quantizeToGrid(
      source.rawNotes,
      source.bpm,
      source.offset,
      divisor,
      preserveChords,
    );
    if (result.length > prevAvailableCount && result.length < sourceCount) {
      return {
        notes: result,
        count: result.length,
        available: true,
        source,
        mapperShipped: false,
      };
    }
  }
  return emptyTier();
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
