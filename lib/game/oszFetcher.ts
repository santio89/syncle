/**
 * Browser-side fetcher for osu!mania .osz beatmapsets.
 *
 * Why this exists: in "remote" mode, Syncle picks a beatmapset from a pool
 * at runtime instead of relying on assets we ship in the repo or in a
 * GitHub Release. The same bytes the official osu! game would download are
 * pulled from a public mirror, unzipped in-memory in the user's browser,
 * the 4K mania chart is extracted, and the audio is handed off to the
 * AudioEngine as raw bytes — no network roundtrip back to our origin.
 *
 * Why it's safe-ish: every mirror we use sets `Access-Control-Allow-Origin: *`
 * and does not require auth. We try them in order and fail over silently.
 *
 * Why it's NOT for production at scale: third-party mirrors can rate-limit
 * or disappear without notice. For "few test songs" / personal use, fine.
 * For production, prefer a vetted bundle (GitHub Release or /public).
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OszMeta {
  /** osu!'s `Mode:` field. We only accept 3 (mania). */
  mode: number;
  /** `CircleSize:` from `[Difficulty]`. For mania this is the keycount. */
  cs: number;
  /** Filename of the audio inside the .osz, from `AudioFilename:`. */
  audio: string;
  title: string;
  artist: string;
  /** Difficulty name (e.g. "Easy", "[4K Hard]"). */
  version: string;
}

export interface ExtractedSong {
  /** The .osu chart text — feed straight into `parseOsu()`. */
  chartText: string;
  /** Raw audio bytes — feed into `AudioEngine.loadFromBytes()`. */
  audioBytes: ArrayBuffer;
  /** Extracted metadata so the UI can show "what just got picked". */
  meta: OszMeta;
  /** Which mirror delivered the bytes (for debug / display). */
  mirror: string;
  /** Beatmapset id used to fetch. */
  beatmapsetId: number;
}

// ---------------------------------------------------------------------------
// Mirror download
// ---------------------------------------------------------------------------

/**
 * Public mirrors that re-host osu! beatmaps with CORS enabled. Order matters:
 * we try these top-down. Adjust if a mirror starts misbehaving in production.
 *
 * Each entry's `url(id)` returns the .osz download URL for that mirror.
 *
 *  - catboy.best     fastest CDN, the trailing "n" suffix = no-video build.
 *  - osu.direct      S3-backed (idrivee2-50.com), per-origin CORS.
 *  - api.nerinyan.moe modern, can be intermittently slow under load.
 */
const MIRRORS: Array<{ name: string; url: (id: number) => string }> = [
  { name: "catboy.best",  url: (id) => `https://catboy.best/d/${id}n` },
  { name: "osu.direct",   url: (id) => `https://osu.direct/api/d/${id}` },
  { name: "nerinyan.moe", url: (id) => `https://api.nerinyan.moe/d/${id}?nv=1&nb=1&nsb=1` },
];

const FETCH_TIMEOUT_MS = 30_000;
/** Smaller than this is almost certainly an empty/error response masquerading as 200. */
const MIN_OSZ_BYTES = 10_000;

async function downloadOsz(
  beatmapsetId: number,
  onProgress?: (msg: string) => void,
): Promise<{ bytes: ArrayBuffer; mirror: string }> {
  const errors: string[] = [];
  for (const m of MIRRORS) {
    const url = m.url(beatmapsetId);
    onProgress?.(`Trying ${m.name}…`);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { redirect: "follow", signal: ac.signal });
      if (!res.ok) {
        errors.push(`${m.name}: HTTP ${res.status}`);
        continue;
      }
      const buf = await res.arrayBuffer();
      if (buf.byteLength < MIN_OSZ_BYTES) {
        errors.push(`${m.name}: empty response (${buf.byteLength} B)`);
        continue;
      }
      return { bytes: buf, mirror: m.name };
    } catch (e: any) {
      errors.push(`${m.name}: ${e?.name === "AbortError" ? "timeout" : e?.message ?? e}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(
    `All mirrors failed for beatmapset ${beatmapsetId}:\n  ${errors.join("\n  ")}`,
  );
}

// ---------------------------------------------------------------------------
// In-browser ZIP reader (central directory walk + DecompressionStream)
// ---------------------------------------------------------------------------

const SIG_EOCD = 0x06054b50;
const SIG_CDFH = 0x02014b50;
const SIG_LFH  = 0x04034b50;

interface ZipEntry {
  name: string;
  /** 0 = stored, 8 = deflated. .osz never uses anything else. */
  compMethod: number;
  compSize: number;
  localOffset: number;
}

interface ZipReader {
  names(): string[];
  read(name: string): Promise<Uint8Array | null>;
}

function readZip(buf: ArrayBuffer): ZipReader {
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);

  // Scan the last ~64KB backward for the End of Central Directory signature.
  let eocd = -1;
  const minStart = Math.max(0, u8.length - 65557);
  for (let i = u8.length - 22; i >= minStart; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a ZIP archive (no EOCD signature found)");

  const totalEntries = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  const td = new TextDecoder("utf-8");
  for (let i = 0; i < totalEntries; i++) {
    if (view.getUint32(p, true) !== SIG_CDFH) {
      throw new Error(`Bad central directory entry at offset ${p}`);
    }
    const compMethod = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = td.decode(u8.subarray(p + 46, p + 46 + nameLen));
    entries.push({ name, compMethod, compSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }

  return {
    names: () => entries.map((e) => e.name),
    async read(name: string) {
      const e = entries.find((x) => x.name === name)
            ?? entries.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (!e) return null;
      const lh = e.localOffset;
      if (view.getUint32(lh, true) !== SIG_LFH) {
        throw new Error(`Bad local file header for "${e.name}"`);
      }
      const lhNameLen = view.getUint16(lh + 26, true);
      const lhExtraLen = view.getUint16(lh + 28, true);
      const dataStart = lh + 30 + lhNameLen + lhExtraLen;
      const compressed = u8.subarray(dataStart, dataStart + e.compSize);

      if (e.compMethod === 0) return new Uint8Array(compressed);
      if (e.compMethod === 8) return await inflateRaw(compressed);
      throw new Error(`Unsupported ZIP compression method ${e.compMethod}`);
    },
  };
}

/**
 * Inflate a raw DEFLATE stream using the built-in DecompressionStream API.
 * Available in all current browsers (Chrome 80+, Firefox 113+, Safari 16.4+).
 * Zero dependencies — no fflate, no jszip.
 */
async function inflateRaw(deflated: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([deflated]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

// ---------------------------------------------------------------------------
// .osu metadata extraction (just headers — we don't parse the chart here)
// ---------------------------------------------------------------------------

function parseOsuMeta(text: string): OszMeta {
  const out: OszMeta = {
    mode: -1, cs: -1, audio: "", title: "", artist: "", version: "",
  };
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const ln = raw.trim();
    if (!ln || ln.startsWith("//")) continue;
    if (ln.startsWith("[") && ln.endsWith("]")) {
      section = ln.slice(1, -1);
      continue;
    }
    const m = ln.match(/^([A-Za-z]+)\s*:\s*(.+)$/);
    if (!m) continue;
    const k = m[1], v = m[2].trim();
    if (section === "General"    && k === "Mode")          out.mode = Number(v);
    if (section === "General"    && k === "AudioFilename") out.audio = v;
    if (section === "Difficulty" && k === "CircleSize")    out.cs = Number(v);
    if (section === "Metadata"   && k === "Title")         out.title = v;
    if (section === "Metadata"   && k === "Artist")        out.artist = v;
    if (section === "Metadata"   && k === "Version")       out.version = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface FetchOszOptions {
  /** Substring (case-insensitive) of the difficulty Version to prefer. */
  diff?: string;
  /** Optional progress callback for the UI ("Trying catboy.best…"). */
  onProgress?: (msg: string) => void;
}

/**
 * Top-level: fetch the .osz, walk the central directory, pick a 4K mania
 * difficulty (matching `opts.diff` if provided, else the first one), and
 * return the chart text + raw audio bytes ready to play.
 */
export async function fetchAndExtract(
  beatmapsetId: number,
  opts: FetchOszOptions = {},
): Promise<ExtractedSong> {
  const { onProgress } = opts;
  const { bytes, mirror } = await downloadOsz(beatmapsetId, onProgress);
  onProgress?.(`Got ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB from ${mirror}, unpacking…`);

  const zip = readZip(bytes);
  const allNames = zip.names();
  const osuFiles = allNames.filter((n) => n.toLowerCase().endsWith(".osu"));
  if (osuFiles.length === 0) {
    throw new Error(`Beatmapset ${beatmapsetId} has no .osu chart files`);
  }

  // Walk every chart to find 4K mania candidates. This is cheap (each .osu
  // is a few KB) and lets us pick by difficulty name without a second pass.
  type Candidate = { name: string; meta: OszMeta; text: string };
  const candidates: Candidate[] = [];
  for (const name of osuFiles) {
    const bytes = await zip.read(name);
    if (!bytes) continue;
    const text = new TextDecoder("utf-8").decode(bytes);
    const meta = parseOsuMeta(text);
    if (meta.mode !== 3 || meta.cs !== 4) continue;
    candidates.push({ name, meta, text });
  }
  if (candidates.length === 0) {
    throw new Error(`Beatmapset ${beatmapsetId} has no 4K mania difficulties`);
  }

  let pick = candidates[0];
  if (opts.diff) {
    const lower = opts.diff.toLowerCase();
    const matched = candidates.find((c) =>
      c.meta.version.toLowerCase().includes(lower),
    );
    if (matched) pick = matched;
  }

  const audioU8 = await zip.read(pick.meta.audio);
  if (!audioU8) {
    throw new Error(
      `Audio file "${pick.meta.audio}" referenced by chart not found inside .osz`,
    );
  }

  // Audio bytes need to be a *standalone* ArrayBuffer (not a view into the
  // zip's buffer) because decodeAudioData detaches what it gets handed.
  // .slice() copies; .buffer would give us the parent ArrayBuffer (5 MB).
  const audioBytes = audioU8.slice().buffer;

  return {
    chartText: pick.text,
    audioBytes,
    meta: pick.meta,
    mirror,
    beatmapsetId,
  };
}
