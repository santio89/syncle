import { Note, SongMeta } from "./types";
import { parseOsu } from "./osu";
import { fetchAndExtract, ExtractedSong } from "./oszFetcher";

/**
 * Empty skeleton meta used as the type-safe initial state before a real
 * chart finishes loading. The UI must check for `meta.title === ""` and
 * show a loading state instead of rendering this placeholder.
 *
 * NOTE: there is intentionally NO usable audioUrl here — there is no
 * "always-works" fallback song shipped with the repo. The only audio
 * that plays is whatever today's manifest entry points to.
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
/* Manifest-driven loading                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Runtime view of an entry in `public/songs/manifest.json`. The manifest is
 * generated at build time by `scripts/build-manifest.mjs` from
 * `songs.config.json` (+ optionally a GitHub Release).
 *
 *   mode = "remote" → audioUrl/chartUrl point at GitHub Releases CDN
 *   mode = "local"  → they point at /songs/... in /public
 *
 * The runtime doesn't care which — it just fetches by URL.
 */
interface ManifestSong {
  id: string;
  title: string;
  artist: string;
  year?: number;
  audioUrl: string;
  chartUrl: string;
}

/** Entry in the remote pool — points at a public mirror beatmapset. */
export interface PoolEntry {
  /** osu! beatmapset id (the number in the URL on osu.ppy.sh/beatmapsets/...). */
  id: number;
  /** Substring of the difficulty Version to prefer (case-insensitive). */
  diff?: string;
  /** Optional human-readable label, used in dev consoles / debug tooltips. */
  label?: string;
}

interface Manifest {
  generatedAt: string;
  mode: "remote" | "local";
  modeReason?: string;
  /**
   * Strategy the runtime should use to pick a chart on each load:
   *   - "daily"  → use today's scheduled song (production behaviour)
   *   - "random" → pick a random entry from `pool`, falling back to
   *                local songs if all mirrors fail (test/dev behaviour)
   */
  pickStrategy?: "daily" | "random";
  schedule: { date: string; songId: string }[];
  songs: Record<string, ManifestSong>;
  /** Beatmapset ids fetched from public mirrors at runtime. */
  pool?: PoolEntry[];
}

let manifestPromise: Promise<Manifest> | null = null;

async function loadManifest(): Promise<Manifest> {
  if (!manifestPromise) {
    manifestPromise = (async () => {
      const res = await fetch("/songs/manifest.json", { cache: "no-store" });
      if (!res.ok) {
        throw new Error(
          `manifest fetch failed: HTTP ${res.status} ` +
            "— did `npm run build:manifest` run?",
        );
      }
      return (await res.json()) as Manifest;
    })().catch((err) => {
      // Reset so a later retry can succeed (e.g. after the user fixes config).
      manifestPromise = null;
      throw err;
    });
  }
  return manifestPromise;
}

/** YYYY-MM-DD in the local timezone — matches the format in songs.config.json. */
function todayKey(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Pick which song the manifest says is "today's". Strategy:
 *   1. exact date match in schedule
 *   2. otherwise the most recent past entry (so the schedule "sticks" when
 *      you forget to add tomorrow's song)
 *   3. otherwise the first song in `songs` (dev fallback)
 */
function pickTodaySong(m: Manifest): ManifestSong {
  const today = todayKey();
  const sorted = [...m.schedule].sort((a, b) => a.date.localeCompare(b.date));
  const exact = sorted.find((e) => e.date === today);
  const past = [...sorted].reverse().find((e) => e.date <= today);
  const fallbackId = Object.keys(m.songs)[0];
  const songId = exact?.songId ?? past?.songId ?? fallbackId;
  const song = songId ? m.songs[songId] : undefined;
  if (!song) throw new Error("manifest has no songs");
  return song;
}

/* ------------------------------------------------------------------------- */
/* Difficulty quantization (unchanged)                                       */
/* ------------------------------------------------------------------------- */

/**
 * Difficulty modes for osu! charts. Most osu!mania beatmaps are charted for
 * advanced players (OD 8+, constant streams). These options thin the chart
 * down to something we can actually play in a casual rhythm game.
 *
 *   easy   → quantize taps to whole beats, max 1 note per beat
 *   normal → quantize taps to half-beats, max 1 note per half-beat
 *   hard   → use the chart as-charted (true difficulty)
 *
 * Hold notes are always preserved as-is — the head time is snapped to the
 * grid for easy/normal but the duration is kept so sustains still feel real.
 */
export type ChartMode = "easy" | "normal" | "hard";

const DEFAULT_MODE: ChartMode = "easy";

/**
 * Quantize TAP notes to a beat grid and keep at most one note per grid cell.
 * Hold notes are kept unconditionally so sustains aren't lost on easy/normal —
 * their head time is just snapped to the nearest grid cell.
 */
function quantizeToGrid(
  notes: Note[],
  bpm: number,
  offsetSec: number,
  gridDivisor: 1 | 2,
): Note[] {
  const beatLen = 60 / bpm;
  const cell = beatLen / gridDivisor;
  if (cell <= 0) return notes;

  const isHold = (n: Note) => n.endT != null && n.endT > n.t + 0.05;

  // Holds: snap head to grid, preserve duration.
  const holds: Note[] = [];
  // Taps: bucket by nearest grid cell (one note per cell).
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
      buckets.set(idx, {
        id: 0,
        t: snapped,
        lane: n.lane,
      });
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

export interface LoadSongResult {
  meta: SongMeta;
  notes: Note[];
  source: "osu";
  /** How many notes the original chart had before easy/normal thinning. */
  rawNoteCount: number;
  mode: ChartMode;
  /**
   * How this song reached the player:
   *   - "local"  → /public asset, fetched from our own origin
   *   - "remote" → unzipped from a mirror's .osz at runtime
   * The UI can use this to show "fetched from catboy.best" etc.
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

/**
 * Per-mode in-memory cache of the most recent successful loadSong result.
 * Lives for the lifetime of the page. Critical for "random" pickStrategy:
 * the random choice is made ONCE on first call, then frozen for the session
 * (preview + start + retries all see the same song). Refresh = new pick.
 */
const loadCache = new Map<ChartMode, Promise<LoadSongResult>>();

/**
 * Resolve a chart according to the manifest's pickStrategy:
 *   - "daily"  → today's scheduled local song
 *   - "random" → random entry from the remote pool, with local fallback
 *
 * Cached per difficulty for the page session. Pass `force: true` to refetch.
 */
export async function loadSong(
  mode: ChartMode = DEFAULT_MODE,
  opts: { force?: boolean; onProgress?: (msg: string) => void } = {},
): Promise<LoadSongResult> {
  if (!opts.force) {
    const cached = loadCache.get(mode);
    if (cached) return cached;
  }
  const p = loadSongUncached(mode, opts.onProgress);
  loadCache.set(mode, p);
  p.catch(() => loadCache.delete(mode));
  return p;
}

async function loadSongUncached(
  mode: ChartMode,
  onProgress?: (msg: string) => void,
): Promise<LoadSongResult> {
  const manifest = await loadManifest();
  const strategy = manifest.pickStrategy ?? "daily";

  if (strategy === "random" && manifest.pool && manifest.pool.length > 0) {
    try {
      return await loadRandomFromPool(manifest, mode, onProgress);
    } catch (err) {
      // All mirrors failed — fall through to local fallback below.
      console.warn("[syncle] remote pool failed, falling back to local:", err);
      onProgress?.("Mirrors unreachable, using local song…");
    }
  }

  return loadLocal(manifest, mode);
}

/* ---- daily / local path -------------------------------------------------- */

async function loadLocal(
  manifest: Manifest,
  mode: ChartMode,
): Promise<LoadSongResult> {
  const song = pickTodaySong(manifest);
  const res = await fetch(song.chartUrl, { cache: "force-cache" });
  if (!res.ok) {
    throw new Error(
      `chart fetch failed for "${song.id}": HTTP ${res.status} (${song.chartUrl})`,
    );
  }
  const text = await res.text();
  const parsed = parseOsu(text);
  if (!parsed) {
    throw new Error(
      `chart for "${song.id}" is not a valid 4K mania beatmap (${song.chartUrl})`,
    );
  }
  return finalize({
    rawNotes: parsed.notes,
    bpm: parsed.bpm,
    offset: parsed.offset,
    duration: parsed.duration,
    mode,
    meta: {
      id: song.id,
      title: song.title,
      artist: song.artist,
      year: song.year,
      audioUrl: song.audioUrl,
    },
    delivery: "local",
  });
}

/* ---- random / remote path ------------------------------------------------ */

/** IDs already picked this session, so reload != same song twice in a row. */
const recentPicks: number[] = [];
const RECENT_WINDOW = 3;

function pickRandomEntry(pool: PoolEntry[]): PoolEntry {
  const fresh = pool.filter((e) => !recentPicks.includes(e.id));
  const choices = fresh.length > 0 ? fresh : pool;
  const pick = choices[Math.floor(Math.random() * choices.length)];
  recentPicks.push(pick.id);
  if (recentPicks.length > RECENT_WINDOW) recentPicks.shift();
  return pick;
}

async function loadRandomFromPool(
  manifest: Manifest,
  mode: ChartMode,
  onProgress?: (msg: string) => void,
): Promise<LoadSongResult> {
  const pool = manifest.pool!;
  // Try a few different entries before declaring full failure — a single bad
  // beatmapset id (e.g. set was deleted on the mirror) shouldn't break the
  // whole random mode if other entries work.
  const tried = new Set<number>();
  let lastErr: unknown;
  for (let attempt = 0; attempt < Math.min(3, pool.length); attempt++) {
    const candidates = pool.filter((e) => !tried.has(e.id));
    if (candidates.length === 0) break;
    const entry = pickRandomEntry(candidates);
    tried.add(entry.id);
    try {
      onProgress?.(`Picking beatmapset ${entry.id}…`);
      const extracted = await fetchAndExtract(entry.id, {
        diff: entry.diff,
        onProgress,
      });
      return chartFromExtracted(extracted, mode);
    } catch (err) {
      console.warn(`[syncle] beatmapset ${entry.id} failed:`, err);
      lastErr = err;
    }
  }
  throw new Error(
    `Random pool exhausted after ${tried.size} attempts: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

function chartFromExtracted(
  ext: ExtractedSong,
  mode: ChartMode,
): LoadSongResult {
  const parsed = parseOsu(ext.chartText);
  if (!parsed) {
    throw new Error(
      `Beatmapset ${ext.beatmapsetId} chart "${ext.meta.version}" failed to parse as 4K mania`,
    );
  }
  // Stable, URL-safe id for the daily-best key. Unique per (set, diff).
  const id = `osu-${ext.beatmapsetId}-${slugify(ext.meta.version)}`;
  const audioKey = `osu:${ext.beatmapsetId}:${ext.meta.version}`;
  return finalize({
    rawNotes: parsed.notes,
    bpm: parsed.bpm,
    offset: parsed.offset,
    duration: parsed.duration,
    mode,
    meta: {
      id,
      title: ext.meta.title,
      artist: ext.meta.artist,
      // No standalone audioUrl — bytes will be loaded via loadFromBytes.
      audioUrl: "",
    },
    delivery: "remote",
    audioBytes: ext.audioBytes,
    audioKey,
    mirror: ext.mirror,
    beatmapsetId: ext.beatmapsetId,
  });
}

/* ---- shared finalization ------------------------------------------------- */

interface FinalizeInput {
  rawNotes: Note[];
  bpm: number;
  offset: number;
  duration: number;
  mode: ChartMode;
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

function finalize(inp: FinalizeInput): LoadSongResult {
  let notes = inp.rawNotes;
  if (inp.mode === "easy") {
    notes = quantizeToGrid(notes, inp.bpm, inp.offset, 1);
  } else if (inp.mode === "normal") {
    notes = quantizeToGrid(notes, inp.bpm, inp.offset, 2);
  }
  const meta: SongMeta = {
    id: inp.meta.id,
    title: inp.meta.title,
    artist: inp.meta.artist,
    year: inp.meta.year,
    bpm: inp.bpm,
    offset: inp.offset,
    duration: inp.duration,
    audioUrl: inp.meta.audioUrl,
    difficulty: inp.mode,
  };
  return {
    meta,
    notes,
    source: "osu",
    rawNoteCount: inp.rawNotes.length,
    mode: inp.mode,
    delivery: inp.delivery,
    audioBytes: inp.audioBytes,
    audioKey: inp.audioKey,
    mirror: inp.mirror,
    beatmapsetId: inp.beatmapsetId,
  };
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "x";
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
