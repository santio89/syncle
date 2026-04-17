// Minimal .osu (osu!mania 4K) parser.
//
// Targets the v14 file format used since 2014. Only what we need to play
// the chart in our 4-lane game; ignores skinning, hitsounds, sliders, etc.
//
// Spec reference: https://osu.ppy.sh/wiki/en/Client/File_formats/Osu_%28file_format%29
//
// Mapping from osu! → our game:
//   - Mode must be 3 (mania)
//   - CircleSize must be 4 (4K)
//   - x-coordinate → column:  col = floor(x * 4 / 512)   (so x ∈ {64,192,320,448})
//   - Hold notes (type bit 7 = 128) become Notes with `endT` populated; the
//     `objectParams` field for a hold is `endTime:hitSample`.
//   - First uninherited timing point sets bpm + offset
//
// On any unrecoverable issue (wrong mode, no notes, etc.) returns null so
// the caller can fall back to the hand-built chart.
//
// SAFE on plain text inputs only — no eval, no DOM, no Node APIs.

import { MAIN_LANE_COUNT, Note } from "./types";

export interface ParsedOsu {
  /** From [Metadata] Title (falls back to TitleUnicode). */
  title: string;
  /** From [Metadata] Artist. */
  artist: string;
  /** From [Metadata] Creator (the charter, not the song's artist). */
  creator: string;
  /** From [Metadata] Version (the difficulty name, e.g. "Easy"). */
  version: string;
  /** From [General] AudioFilename — relative to the .osu file's folder. */
  audioFilename: string;
  /** Beats per minute, derived from the first uninherited timing point. */
  bpm: number;
  /** Seconds — start time of the first uninherited timing point (= song t=0 grid). */
  offset: number;
  /** Seconds — time of the last note + a small tail. Best-effort song length. */
  duration: number;
  /** Notes, sorted by time, lane in 0..3. */
  notes: Note[];
}

const HOLD_BIT = 128;
// osu! mania uses x ∈ [0, 512] split across N columns.
// For 4K: column = floor(x * 4 / 512). Standard column centers are 64,192,320,448.
const COLUMN_DIVISOR = 512 / MAIN_LANE_COUNT;

/**
 * Parse a .osu file (raw text). Returns null if the file is not a 4K mania
 * chart we can handle.
 */
export function parseOsu(text: string): ParsedOsu | null {
  // Strip UTF-8 BOM that some editors prepend.
  const clean = text.replace(/^\uFEFF/, "");
  const lines = clean.split(/\r?\n/);

  type Section =
    | "General"
    | "Editor"
    | "Metadata"
    | "Difficulty"
    | "Events"
    | "TimingPoints"
    | "HitObjects"
    | "Colours"
    | "Other";

  let section: Section = "Other";
  const general: Record<string, string> = {};
  const metadata: Record<string, string> = {};
  const difficulty: Record<string, string> = {};
  const timingPoints: TimingPoint[] = [];
  const hitObjects: HitObjectLine[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("//")) continue;

    if (line.startsWith("[") && line.endsWith("]")) {
      const name = line.slice(1, -1) as Section;
      section = name;
      continue;
    }

    switch (section) {
      case "General":
      case "Metadata":
      case "Difficulty": {
        // "Key:Value" or "Key: Value"
        const idx = line.indexOf(":");
        if (idx < 0) break;
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        if (section === "General") general[key] = value;
        else if (section === "Metadata") metadata[key] = value;
        else difficulty[key] = value;
        break;
      }
      case "TimingPoints": {
        const tp = parseTimingPoint(line);
        if (tp) timingPoints.push(tp);
        break;
      }
      case "HitObjects": {
        const ho = parseHitObject(line);
        if (ho) hitObjects.push(ho);
        break;
      }
      default:
        break;
    }
  }

  // --- Validate it's a 4K mania chart -----------------------------------
  const mode = parseInt(general["Mode"] ?? "0", 10);
  if (mode !== 3) {
    // Not mania.
    return null;
  }
  const keys = parseInt(difficulty["CircleSize"] ?? "0", 10);
  if (keys !== MAIN_LANE_COUNT) {
    // We only support 4K. (5K/6K/7K maps would need column folding.)
    return null;
  }

  // --- BPM + offset from first uninherited timing point ------------------
  const firstUninherited = timingPoints.find((t) => t.uninherited);
  if (!firstUninherited) return null;
  const bpm = 60000 / firstUninherited.beatLengthMs;
  const offsetSec = firstUninherited.offsetMs / 1000;

  // --- Build notes -------------------------------------------------------
  const notes: Note[] = [];
  let id = 0;
  for (const ho of hitObjects) {
    let lane = Math.floor(ho.x / COLUMN_DIVISOR);
    if (lane < 0) lane = 0;
    if (lane >= MAIN_LANE_COUNT) lane = MAIN_LANE_COUNT - 1;
    const t = ho.timeMs / 1000;
    const note: Note = { id: id++, t, lane };
    if (ho.isHold && ho.endTimeMs != null) {
      const endT = ho.endTimeMs / 1000;
      if (endT > t + 0.05) note.endT = endT;
    }
    notes.push(note);
  }
  if (notes.length === 0) return null;

  notes.sort((a, b) => a.t - b.t);
  notes.forEach((n, i) => (n.id = i));

  const lastNote = notes[notes.length - 1];
  const duration = lastNote.t + 2; // small tail so audio outlasts the chart

  return {
    title: metadata["Title"] || metadata["TitleUnicode"] || "Unknown",
    artist: metadata["Artist"] || metadata["ArtistUnicode"] || "Unknown",
    creator: metadata["Creator"] || "",
    version: metadata["Version"] || "",
    audioFilename: general["AudioFilename"] || "audio.mp3",
    bpm,
    offset: offsetSec,
    duration,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface TimingPoint {
  offsetMs: number;
  /** Positive = uninherited (real BPM); negative = inherited (slider velocity %). */
  beatLengthMs: number;
  uninherited: boolean;
}

function parseTimingPoint(line: string): TimingPoint | null {
  // Format: time,beatLength,meter,sampleSet,sampleIndex,volume,uninherited,effects
  // Old maps may omit later fields. Only the first two are guaranteed.
  const parts = line.split(",");
  if (parts.length < 2) return null;
  const offsetMs = Number(parts[0]);
  const beatLengthMs = Number(parts[1]);
  if (!Number.isFinite(offsetMs) || !Number.isFinite(beatLengthMs)) return null;

  // If the 7th field exists use it; otherwise infer from sign of beatLength.
  let uninherited: boolean;
  if (parts.length >= 7 && parts[6] !== "") {
    uninherited = parts[6].trim() === "1";
  } else {
    uninherited = beatLengthMs > 0;
  }
  if (uninherited && beatLengthMs <= 0) return null;
  return { offsetMs, beatLengthMs, uninherited };
}

interface HitObjectLine {
  x: number;
  timeMs: number;
  type: number;
  isHold: boolean;
  /** End time (ms) for hold notes; undefined for taps. */
  endTimeMs?: number;
}

function parseHitObject(line: string): HitObjectLine | null {
  // Format: x,y,time,type,hitSound,objectParams,hitSample
  // For mania holds, objectParams is `endTime:hitSample`.
  const parts = line.split(",");
  if (parts.length < 4) return null;
  const x = Number(parts[0]);
  const timeMs = Number(parts[2]);
  const type = Number(parts[3]);
  if (!Number.isFinite(x) || !Number.isFinite(timeMs) || !Number.isFinite(type)) {
    return null;
  }
  const isHold = (type & HOLD_BIT) !== 0;
  let endTimeMs: number | undefined;
  if (isHold && parts.length >= 6) {
    // parts[5] looks like "169107:0:0:0:0:" — first segment is the end time.
    const head = parts[5].split(":")[0];
    const v = Number(head);
    if (Number.isFinite(v) && v > timeMs) endTimeMs = v;
  }
  return { x, timeMs, type, isHold, endTimeMs };
}
