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
 * Quantize TAP notes to a beat grid and keep at most one note per grid cell.
 * Hold notes are kept unconditionally so sustains aren't lost on the
 * easier tiers — their head time is just snapped to the nearest grid cell.
 *
 * `gridDivisor` controls how many cells fit in one beat:
 *   1 → whole beats     (≈ Easy density)
 *   2 → half beats      (≈ Medium density)
 *   4 → 16th notes      (≈ Insane density — used when the .osz has no
 *                        mapper-shipped Insane chart but ships something
 *                        denser like Expert that we can thin down)
 *
 * Higher divisors leave more notes alive, lower divisors thin more
 * aggressively. We never go higher than 4 — anything denser is "play
 * the source as-is" territory and gets handled by the Expert tier.
 */
function quantizeToGrid(
  notes: Note[],
  bpm: number,
  offsetSec: number,
  gridDivisor: 1 | 2 | 4,
): Note[] {
  const beatLen = 60 / bpm;
  const cell = beatLen / gridDivisor;
  if (cell <= 0) return notes;

  const isHold = (n: Note) => n.endT != null && n.endT > n.t + 0.05;

  const holds: Note[] = [];
  const buckets = new Map<number, Note>();

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
    if (!buckets.has(idx)) {
      buckets.set(idx, { id: 0, t: snapped, lane: n.lane });
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
 *   hard   → always available (densest chart fallback always exists)
 *   normal → available iff a mapper chart fits this bucket OR
 *            quantization actually thinned (`normalCount < hardCount`)
 *   easy   → available iff a mapper chart fits this bucket OR
 *            quantization actually thinned (`easyCount < normalCount`)
 *   insane → mapper-only — available iff a mapper chart fits this bucket
 *   expert → mapper-only — available iff a mapper chart fits this bucket
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
      return rawSessionFromExtracted(extracted);
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

function rawSessionFromExtracted(ext: ExtractedSongFull): RawSession {
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
 * Resolve every Syncle tier to concrete notes + availability + density,
 * then return the result for the requested mode.
 *
 * Bucket rules:
 *   easy / normal / insane → mapper chart if present; else QUANTIZE from
 *                            the densest source chart (`base`) at the
 *                            tier's grid resolution:
 *                              easy   → 1/1 beat (whole beats)
 *                              normal → 1/2 beat (half beats)
 *                              insane → 1/4 beat (16th notes)
 *   hard                   → mapper chart if present; else the densest
 *                            chart as-is (`hard` is our floor — always
 *                            available so every song is at least playable)
 *   expert                 → mapper chart ONLY. There's nothing in the
 *                            .osz denser than `base` to thin from, so
 *                            "synthesizing Expert" would mean playing
 *                            `base` directly — which is what `hard`
 *                            already does as fallback. We refuse to
 *                            promote a chart the mapper labeled as
 *                            anything-but-Expert into the Expert slot.
 *
 * Availability rules:
 *   easy / normal → mapper chart present, OR quantization actually
 *                   thinned the next-denser bucket (otherwise both
 *                   buttons would play the same notes, which is
 *                   misleading)
 *   hard          → always
 *   insane        → mapper chart present, OR the quantized result is
 *                   strictly denser than Hard AND strictly less dense
 *                   than the source. Both conditions matter: if the
 *                   source already sits at our quantized Insane density
 *                   the button would just replay the source; if Hard is
 *                   already at that density the button would just
 *                   replay Hard. Either way you get a redundant tier.
 *   expert        → mapper chart present (no quantization fallback,
 *                   see above)
 */
function finalize(session: RawSession, mode: ChartMode): LoadSongResult {
  const base = session.fallbackBase;
  const baseCount = base.rawNotes.length;

  const easyResolved =
    session.bucketCharts.easy?.rawNotes ??
    quantizeToGrid(base.rawNotes, base.bpm, base.offset, 1);
  const normalResolved =
    session.bucketCharts.normal?.rawNotes ??
    quantizeToGrid(base.rawNotes, base.bpm, base.offset, 2);
  const hardResolved = session.bucketCharts.hard?.rawNotes ?? base.rawNotes;
  // Insane: prefer mapper chart, else thin the densest source to a
  // 16th-note grid. This catches the common case where a .osz ships
  // Easy/Normal/Hard/Expert but no mapper Insane — without this,
  // players would see Insane greyed out even though we clearly have
  // enough source density to synthesize an Insane-feeling tier.
  const insaneResolved =
    session.bucketCharts.insane?.rawNotes ??
    quantizeToGrid(base.rawNotes, base.bpm, base.offset, 4);
  const expertResolved = session.bucketCharts.expert?.rawNotes ?? [];

  const easyCount = easyResolved.length;
  const normalCount = normalResolved.length;
  const hardCount = hardResolved.length;
  const insaneCount = insaneResolved.length;
  const expertCount = expertResolved.length;

  const easyAvailable = !!session.bucketCharts.easy || easyCount < normalCount;
  const normalAvailable =
    !!session.bucketCharts.normal || normalCount < hardCount;
  // Quantized Insane is meaningful only when it sits strictly between
  // Hard and the source. If `insaneCount === hardCount` the button
  // would replay Hard's notes; if `insaneCount === baseCount` it would
  // replay whatever Hard already replays as fallback (or Expert if
  // mapper-shipped). Either way: redundant tier → disable.
  const insaneAvailable =
    !!session.bucketCharts.insane ||
    (insaneCount > hardCount && insaneCount < baseCount);
  const expertAvailable = !!session.bucketCharts.expert;

  // Pick the chart that matches the requested mode. For insane/expert with
  // no mapper chart we fall back to `base` so audio metadata (bpm, offset,
  // duration) is still valid — the caller is expected to honor
  // `modes.available[mode]` and never pass an unavailable mode through.
  const notes =
    mode === "easy"
      ? easyResolved
      : mode === "normal"
        ? normalResolved
        : mode === "hard"
          ? hardResolved
          : mode === "insane"
            ? insaneResolved
            : expertResolved;
  const chartForMode = session.bucketCharts[mode] ?? base;

  // Per-tier duration: prefer the bucket's mapper chart duration (it can
  // differ from the densest chart's, since mappers sometimes cut intros
  // for easier diffs); else fall back to `base.duration`. Used so the NPS
  // we surface to the UI matches what the player will actually feel.
  const safeDiv = (n: number, d: number) => (d > 0 ? n / d : 0);
  const dur = (m: ChartMode) =>
    (session.bucketCharts[m] ?? base).duration;

  const modes: ModeAvailability = {
    noteCounts: {
      easy: easyCount,
      normal: normalCount,
      hard: hardCount,
      insane: insaneCount,
      expert: expertCount,
    },
    available: {
      easy: easyAvailable,
      normal: normalAvailable,
      hard: true,
      insane: insaneAvailable,
      expert: expertAvailable,
    },
    // Zero out NPS for unavailable tiers so the UI doesn't show a stale
    // density for a button it can't even click. Available tiers get the
    // real density from their resolved chart + that bucket's duration.
    npsByMode: {
      easy: easyAvailable ? safeDiv(easyCount, dur("easy")) : 0,
      normal: normalAvailable ? safeDiv(normalCount, dur("normal")) : 0,
      hard: safeDiv(hardCount, dur("hard")),
      insane: insaneAvailable ? safeDiv(insaneCount, dur("insane")) : 0,
      expert: expertAvailable ? safeDiv(expertCount, dur("expert")) : 0,
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
  };
  return {
    meta,
    notes,
    source: "osu",
    rawNoteCount: base.rawNotes.length,
    mode,
    modes,
    delivery: session.delivery,
    audioBytes: session.audioBytes,
    audioKey: session.audioKey,
    mirror: session.mirror,
    beatmapsetId: session.beatmapsetId,
  };
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
