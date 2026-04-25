import { Note, SongMeta } from "./types";
import { parseOsu } from "./osu";
import {
  fetchAndExtractAll,
  ExtractedChart,
  ExtractedSongFull,
  pickRandomManiaBeatmapsetId,
} from "./oszFetcher";
import { ChartMode, MODE_ORDER, assignBucket } from "./difficulty";

// Re-export the public bits of the difficulty module so existing
// importers (`@/lib/game/chart`'s ChartMode / MODE_ORDER / displayMode)
// keep working without touching every call site. The classification
// implementation lives in `./difficulty` because the server's catalog
// normalizer needs it too and can't transitively pull in the audio /
// blob deps that chart.ts brings.
export type { ChartMode } from "./difficulty";
export { MODE_ORDER, displayMode } from "./difficulty";

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
/* Difficulty resolution                                                     */
/* ------------------------------------------------------------------------- */

/**
 * Syncle difficulty modes - five universal tiers (easy / normal / hard /
 * insane / expert) that mirror osu!mania's own naming scheme. Same
 * vocabulary works across the homepage card, the in-game picker, the
 * multiplayer lobby, and the saved-score keys.
 *
 * Resolution model - "originals only" (no synthesis):
 *
 *   - For each beatmapset, every parsed mapper chart is bucketed into one
 *     of the five tiers via {@link assignBucket} (mapper-named tier with
 *     density validation, falling back to pure density classification when
 *     the name is uninformative). At most one mapper chart wins per
 *     bucket; a tier with no winning mapper chart is simply UNAVAILABLE.
 *
 *   - When a tier is unavailable the picker disables that button. The
 *     player sees exactly the difficulties the mapper actually shipped -
 *     no quantization, no subsampling, no grid-snapping. The previous
 *     "synthesize a tier from the densest chart" path was removed because
 *     re-timed notes drifted off the song's beat just enough to feel
 *     wrong on careful listens (the user complaint that motivated this
 *     refactor: "some things seem out of beat").
 *
 *   - Difficulty NAMES (`ChartMode`) and the canonical order
 *     (`MODE_ORDER`) live in `./difficulty` so the catalog server can
 *     bucket charts during normalization without dragging in this file's
 *     audio / blob deps. We re-export them above so existing
 *     `@/lib/game/chart` imports keep working unchanged.
 *
 * NOTE on the wire/storage value `"normal"`: kept for the second tier
 * instead of renaming to `"medium"` because localStorage best keys, the
 * multiplayer protocol, and persisted run history all reference it. The
 * user-facing label is mapped to `"medium"` via {@link displayMode}.
 */
const DEFAULT_MODE: ChartMode = "easy";

/**
 * Canonical "intensity stars" for each tier. Kept fixed (1..5,
 * easy → expert) instead of deriving from the loaded chart's nps so
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
 *   - Mapper-shipped tier → available, with the mapper's raw note count
 *     and nps. Tiers are populated by routing each parsed mapper chart
 *     through `assignBucket(version, nps)` (see `lib/game/difficulty.ts`).
 *   - No mapper chart for that bucket → unavailable. The picker disables
 *     the button. We don't synthesize from neighbouring tiers anymore -
 *     re-timing notes drifted them just off the song's beat enough to
 *     feel wrong on careful play, and an honest "not available" beats a
 *     subtly-mistimed Easy.
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
  /** Set when delivery === "remote" - raw audio bytes for AudioEngine.loadFromBytes. */
  audioBytes?: ArrayBuffer;
  /** Set when delivery === "remote" - opaque dedup key for the audio cache. */
  audioKey?: string;
  /** Set when delivery === "remote" - which mirror served the bytes. */
  mirror?: string;
  /** Set when delivery === "remote" - beatmapset id we pulled. */
  beatmapsetId?: number;
}

/* ------------------------------------------------------------------------- */
/* Local fallback songs                                                      */
/* ------------------------------------------------------------------------- */

/**
 * Songs shipped in /public/songs/ - used as a fallback when every public
 * mirror search API is unreachable. Two is enough for "I can still play
 * something offline / when APIs are down". Add more by dropping a folder
 * under public/songs/<slug>/ with audio.mp3 + chart.osu and listing it here.
 *
 * The runtime never picks from this list as long as a mirror is reachable -
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
 * One parsed chart inside a session - either a mapper-provided difficulty
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
 * Captured ONCE per page session - switching modes is a free O(1) lookup
 * into `bucketCharts`, never another network roll.
 *
 * `bucketCharts` holds at most one mapper chart per bucket (best name +
 * density match wins ties; see `rawSessionFromExtracted`). Buckets with
 * no qualifying mapper chart are simply absent - those tiers will be
 * marked unavailable in the picker. `fallbackBase` is the densest chart
 * we parsed and is used by local-fallback songs (which ship only one
 * .osu and so populate at most one bucket) for chart-level metadata.
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
    /** Beatmapset moderation status - "ranked", "loved", etc. */
    status?: string;
    /** Mapper username - used as a credit line in the UI. */
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
 *   - Subsequent calls (e.g. switching difficulty): reuse the cached raw
 *     session and pull a different mapper chart out of `bucketCharts`.
 *     No re-download, no re-parse.
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
    // Dev-only - these warnings are signal during local debugging
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

  // 2) Local fallback - random pick across whatever ships in /public/songs/.
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
      // error - search APIs either work or they don't, retrying produces
      // the same failure. Surface immediately so the caller can fall back.
      throw err;
    }
    if (triedSets.has(pick.beatmapsetId)) {
      // Random search rolled the same id twice in a row - try once more.
      continue;
    }
    triedSets.add(pick.beatmapsetId);
    try {
      onProgress?.(
        `Picked beatmapset ${pick.beatmapsetId}${
          pick.title ? ` (${pick.artist} - ${pick.title})` : ""
        }, downloading…`,
      );
      const extracted = await fetchAndExtractAll(pick.beatmapsetId, { onProgress });
      return rawSessionFromExtracted(extracted, {
        status: pick.status,
        creator: pick.creator,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Dev-only - same rationale as the outer mirror-failed warn.
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
  //   - Hard / Insane / Expert: prefer HIGHER nps (more challenge,
  //     closer to band max). Expert is now uncapped - if a mapper
  //     ships a 25-nps "Lunatic" the player gets it as-is, since the
  //     "originals only" model means we don't thin notes anymore.
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

  // Densest chart in the set, regardless of bucket - kept around for
  // chart-level metadata / fallback id generation. Synthesis is gone,
  // so this no longer feeds resolveTier directly.
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
  // Local fallback songs ship a single .osu - bucket it by density so
  // the picker enables exactly the tier it actually belongs to and
  // disables the rest. Since synthesis was removed there's no longer a
  // way for the player to "play this song on Easy" if the local chart
  // is a Hard, but local fallbacks only fire when every public mirror
  // is unreachable, so this lives in the "best-effort offline mode"
  // budget - a single playable difficulty beats no song at all.
  const nps = parsed.duration > 0 ? parsed.notes.length / parsed.duration : 0;
  const fallbackBase: RawChart = {
    rawNotes: parsed.notes,
    bpm: parsed.bpm,
    offset: parsed.offset,
    duration: parsed.duration,
    version: "",
    nps,
  };
  const localBucket = assignBucket(fallbackBase.version, fallbackBase.nps);
  const bucketCharts: Partial<Record<ChartMode, RawChart>> = {
    [localBucket]: fallbackBase,
  };
  return {
    bucketCharts,
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

/* ---- finalize (per-mode resolution) -------------------------------------- */

/**
 * Per-tier resolution result. Tracks the notes plus the mapper chart
 * they came from, so chart-level metadata (bpm, offset, duration) can
 * be sourced from the right place when the player switches mode.
 *
 * In the "originals only" model `notes === source.rawNotes` whenever
 * the tier is available - `mapperShipped` is now always `true` for
 * available tiers, kept on the type for downstream code that still
 * branches on it (HUD "raw N notes" badge etc.).
 */
interface ResolvedTier {
  notes: Note[];
  count: number;
  available: boolean;
  /**
   * The mapper chart this tier maps to. `null` only for unavailable
   * tiers (no mapper chart was bucketed into this tier).
   */
  source: RawChart | null;
  /**
   * Always `true` for available tiers post-refactor; kept on the type
   * because HUD badges and `LoadSongResult.rawNoteCount` still reference
   * it as a "is this a real mapper chart?" flag.
   */
  mapperShipped: boolean;
}

/**
 * Resolve every Syncle tier to concrete notes + availability, then
 * return the result for the requested mode.
 *
 * Resolution is dead simple now that synthesis is gone:
 *   - mapper-shipped chart in the bucket → use it AS-IS (no thinning,
 *     no grid-snap, no Expert capping). What the mapper made is what
 *     the player gets.
 *   - bucket empty → tier disabled, picker greys it out.
 *
 * The previous model that synthesized missing tiers from the densest
 * mapper chart was removed because the re-timed notes drifted just off
 * the song's beat enough to feel wrong on careful play, and we'd
 * rather show the player an honest "Easy not available" than a
 * subtly-mistimed Easy.
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

  for (const tier of MODE_ORDER) {
    tiers[tier] = resolveTier(tier, buckets);
  }

  const requested = tiers[mode];
  // Audio metadata source: the mapper chart that owns this tier, or the
  // fallback (used by local-fallback songs where the same chart drives
  // every available tier - typically only one bucket is populated for a
  // local song since they ship a single .osu).
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
    // `rawNoteCount` always equals the requested tier's note count now
    // (mapper chart is used as-is, no thinning). Kept on the result for
    // backward compat with the HUD's "raw N" badge - it'll just always
    // match `requested.count`. Falls back to `base` only for the
    // pathological case where the caller requests an unavailable tier.
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
 * Resolve a single tier - mapper-only, no synthesis.
 *
 * `buckets[tier]` was populated in `rawSessionFromExtracted` by walking
 * every parsed mapper chart in the .osz and routing it through
 * `assignBucket(version, nps)`. So if a chart exists here, it's a real
 * mapper-made difficulty whose density was validated against the tier's
 * band (see `lib/game/difficulty.ts`).
 *
 * If no mapper chart maps to this tier, we mark it unavailable. The
 * picker disables the button; the player picks something else. This is
 * the explicit contract: "originals only, disable what isn't shipped".
 */
function resolveTier(
  tier: ChartMode,
  buckets: Partial<Record<ChartMode, RawChart>>,
): ResolvedTier {
  const mapper = buckets[tier];
  if (!mapper) return emptyTier();
  return {
    notes: mapper.rawNotes,
    count: mapper.rawNotes.length,
    available: true,
    source: mapper,
    mapperShipped: true,
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
