import { Note, SongMeta } from "./types";
import { parseOsu } from "./osu";

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

interface Manifest {
  generatedAt: string;
  mode: "remote" | "local";
  modeReason?: string;
  schedule: { date: string; songId: string }[];
  songs: Record<string, ManifestSong>;
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
}

/**
 * Resolve today's song from the manifest, fetch + parse its osu! chart, and
 * return a playable result. Rejects with a descriptive error if the manifest
 * is missing, the song schedule is empty, or the chart isn't 4K mania.
 */
export async function loadSong(
  mode: ChartMode = DEFAULT_MODE,
): Promise<LoadSongResult> {
  const manifest = await loadManifest();
  const song = pickTodaySong(manifest);

  // GitHub Releases (and our local /public) serve immutable bytes per URL,
  // so an aggressive cache hint cuts retries from ~5 MB/play to ~0.
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

  let notes = parsed.notes;
  if (mode === "easy") {
    notes = quantizeToGrid(notes, parsed.bpm, parsed.offset, 1);
  } else if (mode === "normal") {
    notes = quantizeToGrid(notes, parsed.bpm, parsed.offset, 2);
  }

  const meta: SongMeta = {
    id: song.id,
    title: song.title,
    artist: song.artist,
    year: song.year,
    bpm: parsed.bpm,
    offset: parsed.offset,
    duration: parsed.duration,
    audioUrl: song.audioUrl,
    difficulty: mode,
  };

  return {
    meta,
    notes,
    source: "osu",
    rawNoteCount: parsed.notes.length,
    mode,
  };
}
