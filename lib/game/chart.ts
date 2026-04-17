import { Note, SongMeta } from "./types";
import { parseOsu } from "./osu";

/**
 * Empty skeleton meta used as the type-safe initial state before a real
 * chart finishes loading. The UI must check for `meta.title === ""` and
 * show a loading state instead of rendering this placeholder.
 *
 * NOTE: there is intentionally NO usable audioUrl here — there is no
 * "always-works" fallback song shipped with the repo. The only audio
 * that plays is whatever the loaded osu! beatmap points to.
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

/**
 * Candidate osu! beatmaps to try, in order. The first one whose chart file
 * loads + parses as 4K mania wins. Each entry pairs a `.osu` chart with the
 * audio file it expects (relative to /public).
 *
 *   public/songs/today/chart.osu      ← preferred drop-in slot for the daily
 *   public/songs/osu-mania/...        ← dev test set
 */
interface OsuCandidate {
  chartUrl: string;
  audioUrl: string;
  /** Override song meta (title/artist) when this chart is the one used. */
  metaOverride?: Partial<Pick<SongMeta, "title" | "artist" | "year" | "id">>;
}

const OSU_CANDIDATES: OsuCandidate[] = [
  // Drop-in slot for the "official" daily song. If you put a chart.osu +
  // audio.mp3 here it takes precedence over everything else.
  {
    chartUrl: "/songs/today/chart.osu",
    audioUrl: "/songs/today/audio.mp3",
  },
  // Dev test beatmap: Kajiura Yuki - Credens justitiam, charted by Quowjaz.
  // Using the 0.9x time-stretched version (slowest audio + matching chart
  // timings) so streams are more readable on easy/normal.
  {
    chartUrl:
      "/songs/osu-mania/Kajiura Yuki - Credens justitiam (Extended Edit) ([Crz]Zetsfy) [Quowjaz 0.9x].osu",
    audioUrl: "/songs/osu-mania/audio 0.900x.mp3",
    metaOverride: {
      id: "credens-justitiam",
      title: "Credens justitiam",
      artist: "Kajiura Yuki",
      year: 2011,
    },
  },
];

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

/** Default mode if the caller doesn't specify. */
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

/**
 * URL-encode a path segment-by-segment so spaces, brackets and parens in
 * filenames (very common in osu! beatmaps) survive the round-trip through
 * fetch() and Next's static handler. Slashes between segments are kept.
 */
function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/**
 * Try each candidate beatmap in order. Returns the first one that loads as
 * a valid 4K mania chart. Falls back to the hand-built chart if none work.
 *
 * The returned `meta` has bpm/offset/duration taken from the .osu file so
 * the rhythm engine locks to the actual song timing, not our guesses.
 */
export interface LoadSongResult {
  meta: SongMeta;
  notes: Note[];
  source: "osu";
  /** How many notes the original chart had before easy/normal thinning. */
  rawNoteCount: number;
  mode: ChartMode;
}

/**
 * Try every candidate osu! beatmap until one loads. Resolves with the
 * playable chart, or rejects with an error describing what failed (no
 * silent fallback — there's no shipped audio to fall back to).
 */
export async function loadSong(
  mode: ChartMode = DEFAULT_MODE,
): Promise<LoadSongResult> {
  const errors: string[] = [];
  for (const cand of OSU_CANDIDATES) {
    const encodedChart = encodePath(cand.chartUrl);
    try {
      const res = await fetch(encodedChart, { cache: "no-store" });
      if (!res.ok) {
        if (res.status !== 404) {
          errors.push(`${encodedChart} → HTTP ${res.status}`);
        }
        continue;
      }
      const text = await res.text();
      const parsed = parseOsu(text);
      if (!parsed) {
        errors.push(`${encodedChart} parsed null (not 4K mania?)`);
        continue;
      }

      let notes = parsed.notes;
      if (mode === "easy") {
        notes = quantizeToGrid(notes, parsed.bpm, parsed.offset, 1);
      } else if (mode === "normal") {
        notes = quantizeToGrid(notes, parsed.bpm, parsed.offset, 2);
      }

      const meta: SongMeta = {
        id: cand.metaOverride?.id ?? "today",
        title: cand.metaOverride?.title ?? parsed.title,
        artist: cand.metaOverride?.artist ?? parsed.artist,
        year: cand.metaOverride?.year,
        bpm: parsed.bpm,
        offset: parsed.offset,
        duration: parsed.duration,
        audioUrl: encodePath(cand.audioUrl),
        difficulty: mode,
      };
      return {
        meta,
        notes,
        source: "osu",
        rawNoteCount: parsed.notes.length,
        mode,
      };
    } catch (err) {
      errors.push(`${encodedChart} threw ${(err as Error)?.message ?? err}`);
    }
  }

  const detail = errors.length ? ` (${errors.join("; ")})` : "";
  throw new Error(`No playable chart found${detail}`);
}

