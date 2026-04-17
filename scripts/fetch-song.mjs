#!/usr/bin/env node
/**
 * Fetch an osu!mania 4K beatmapset from a public mirror, extract the audio
 * + the matching .osu chart, and drop them under public/songs/ so you can
 * wire them up in songs.config.json without leaving the terminal.
 *
 * No external deps — uses fetch + a tiny built-in ZIP reader powered by
 * node:zlib. The .osz format is just a renamed ZIP.
 *
 * Usage:
 *   npm run fetch-song -- search "<query>"
 *   npm run fetch-song -- <beatmapsetId> [diff-name-substring]
 *
 * Examples:
 *   npm run fetch-song -- search "camellia bang riot"
 *   npm run fetch-song -- 552674
 *   npm run fetch-song -- 552674 "Hard"
 *
 * Mirrors used (in order — falls through on failure):
 *   - https://api.nerinyan.moe   (modern, fast, has search)
 *   - https://catboy.best         (Mino — older but very stable)
 *
 * Both are public re-hosts of the official osu! beatmaps. No login needed,
 * no client install. They serve the exact same .osz bytes osu! does.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { Buffer } from "node:buffer";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SONGS_DIR = join(ROOT, "public", "songs");

// ---------------------------------------------------------------------------
// Tiny ZIP reader. Handles the only two compression methods .osz files use:
//   0 = stored (raw bytes), 8 = DEFLATE. .osz never uses anything fancier.
// ---------------------------------------------------------------------------

const SIG_EOCD = 0x06054b50; // End of Central Directory
const SIG_CDFH = 0x02014b50; // Central Directory File Header
const SIG_LFH  = 0x04034b50; // Local File Header

function readZip(buf) {
  // EOCD lives in the last ~22..65557 bytes. Scan backwards for its signature.
  let eocd = -1;
  const minStart = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minStart; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a ZIP archive (no EOCD signature)");

  const totalEntries = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (buf.readUInt32LE(p) !== SIG_CDFH) {
      throw new Error(`Bad central directory entry at offset ${p}`);
    }
    const compMethod = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    // .osz uses UTF-8 names (bit 11 of general purpose flag).
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    entries.push({ name, compMethod, compSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }

  return {
    names: () => entries.map((e) => e.name),
    read(name) {
      // Allow case-insensitive lookups — AudioFilename in .osu is sometimes
      // a different case from the actual filename in the archive.
      const e = entries.find((x) => x.name === name)
            ?? entries.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (!e) return null;
      const lh = e.localOffset;
      if (buf.readUInt32LE(lh) !== SIG_LFH) {
        throw new Error(`Bad local file header for "${e.name}"`);
      }
      const lhNameLen = buf.readUInt16LE(lh + 26);
      const lhExtraLen = buf.readUInt16LE(lh + 28);
      const dataStart = lh + 30 + lhNameLen + lhExtraLen;
      const raw = buf.subarray(dataStart, dataStart + e.compSize);
      if (e.compMethod === 0) return Buffer.from(raw);
      if (e.compMethod === 8) return inflateRawSync(raw);
      throw new Error(`Unsupported ZIP compression method ${e.compMethod}`);
    },
  };
}

// ---------------------------------------------------------------------------
// .osu metadata extraction (no chart parsing — we just need the headers).
// ---------------------------------------------------------------------------

function parseOsuMeta(text) {
  const out = {
    mode: -1, cs: -1,
    audio: "", title: "", artist: "", version: "",
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

function slugify(s) {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// ---------------------------------------------------------------------------
// API calls.
// ---------------------------------------------------------------------------

async function searchMirror(query) {
  const url = `https://api.nerinyan.moe/search?m=3&q=${encodeURIComponent(query)}&ps=10`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Search failed: HTTP ${res.status}`);
  return res.json();
}

/**
 * Try a list of mirrors in order; return the first .osz that downloads
 * successfully. Each fetch is wrapped in a hard timeout so a slow mirror
 * (NeriNyan in particular goes spotty under load) doesn't hang us forever.
 */
async function downloadOsz(id) {
  // catboy.best first — measured fastest + most reliable as of testing.
  // The trailing "n" on catboy = "no video" variant, much smaller download.
  // NeriNyan as fallback (it can intermittently return 0-byte responses).
  const urls = [
    `https://catboy.best/d/${id}n`,
    `https://catboy.best/d/${id}`,
    `https://api.nerinyan.moe/d/${id}?nv=1&nb=1&nsb=1`,
  ];
  for (const url of urls) {
    process.stdout.write(`  fetch ${url} ... `);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 30_000);
    try {
      const res = await fetch(url, { redirect: "follow", signal: ac.signal });
      if (!res.ok) {
        console.log(`HTTP ${res.status}`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      // Sanity check: a real .osz is at minimum ~50KB (audio dominates).
      // Some mirrors return 200 with an empty body when an asset is missing.
      if (buf.length < 10_000) {
        console.log(`empty (${buf.length} bytes) — skipping`);
        continue;
      }
      console.log(`${(buf.length / 1024 / 1024).toFixed(1)} MB ok`);
      return buf;
    } catch (e) {
      console.log(`FAILED (${e.name === "AbortError" ? "timeout" : e.message})`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`All mirrors failed for beatmapset ${id}`);
}

// ---------------------------------------------------------------------------
// Commands.
// ---------------------------------------------------------------------------

async function cmdSearch(query) {
  if (!query) {
    console.error("Usage: npm run fetch-song -- search <query>");
    process.exit(1);
  }
  console.log(`Searching mania charts for: ${query}\n`);
  const sets = await searchMirror(query);
  let printed = 0;
  for (const s of sets) {
    const fourK = (s.beatmaps || []).filter(
      (b) => b.mode_int === 3 && b.cs === 4,
    );
    if (fourK.length === 0) continue;
    printed++;
    console.log(
      `  [${String(s.id).padStart(7)}]  ${s.artist} — ${s.title}`,
    );
    for (const b of fourK.slice(0, 4)) {
      const stars = (b.difficulty_rating ?? 0).toFixed(2);
      console.log(`              · ${b.version}  (★${stars})`);
    }
  }
  if (printed === 0) {
    console.log("  (no 4K mania charts in the top results — try a different query)");
    return;
  }
  console.log(`\nInstall one:  npm run fetch-song -- <id> [diff-name]`);
  console.log(`Example:      npm run fetch-song -- ${sets[0].id} "Hard"`);
}

async function cmdInstall(id, diffSubstr) {
  console.log(`Downloading beatmapset ${id} ...`);
  const osz = await downloadOsz(id);

  console.log(`Reading archive ...`);
  const zip = readZip(osz);
  const osuFiles = zip.names().filter((n) => n.toLowerCase().endsWith(".osu"));
  if (osuFiles.length === 0) {
    throw new Error("Archive has no .osu chart files");
  }

  const candidates = [];
  for (const name of osuFiles) {
    const text = zip.read(name).toString("utf8");
    const meta = parseOsuMeta(text);
    if (meta.mode !== 3 || meta.cs !== 4) continue;
    candidates.push({ name, meta, text });
  }
  if (candidates.length === 0) {
    console.error("\nNo 4K mania difficulties in this set. Available diffs:");
    for (const name of osuFiles) {
      const meta = parseOsuMeta(zip.read(name).toString("utf8"));
      console.error(`  · ${meta.version}  mode=${meta.mode} cs=${meta.cs}`);
    }
    process.exit(1);
  }

  let pick = candidates[0];
  if (diffSubstr) {
    const lower = diffSubstr.toLowerCase();
    const matched = candidates.find((c) =>
      c.meta.version.toLowerCase().includes(lower),
    );
    if (!matched) {
      console.error(`\nNo 4K mania diff matching "${diffSubstr}". Available 4K diffs:`);
      for (const c of candidates) console.error(`  · ${c.meta.version}`);
      process.exit(1);
    }
    pick = matched;
  }

  const audioBytes = zip.read(pick.meta.audio);
  if (!audioBytes) {
    throw new Error(`Audio file "${pick.meta.audio}" not found inside .osz`);
  }

  // Output: public/songs/<artist>-<title>/{audio.<ext>,chart.osu}
  // Predictable filenames keep songs.config.json clean and URL-safe.
  const slug = slugify(`${pick.meta.artist}-${pick.meta.title}`);
  const outDir = join(SONGS_DIR, slug);
  mkdirSync(outDir, { recursive: true });

  const audioExt = extname(pick.meta.audio).toLowerCase() || ".mp3";
  const audioOut = `audio${audioExt}`;
  const chartOut = "chart.osu";

  writeFileSync(join(outDir, audioOut), audioBytes);
  writeFileSync(join(outDir, chartOut), zip.read(pick.name));

  console.log(`\n✓ Installed: public/songs/${slug}/`);
  console.log(`  ${pick.meta.artist} — ${pick.meta.title}  [${pick.meta.version}]`);
  console.log(`  ${audioOut}  (${(audioBytes.length / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`  ${chartOut}  (${pick.text.length} bytes)\n`);

  console.log("Add this to songs.config.json under \"songs\":\n");
  console.log(
    "  " +
      JSON.stringify(
        {
          [slug]: {
            title: pick.meta.title,
            artist: pick.meta.artist,
            audio: `${slug}/${audioOut}`,
            chart: `${slug}/${chartOut}`,
          },
        },
        null,
        2,
      ).replace(/\n/g, "\n  "),
  );
  console.log(
    `\nAnd schedule it for a date under "schedule":` +
      `\n  { "date": "YYYY-MM-DD", "songId": "${slug}" }\n`,
  );
  console.log("Then `npm run build:manifest` (or just restart `npm run dev`).");
}

// ---------------------------------------------------------------------------
// Entry.
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const [cmd, arg2] = args;

if (!cmd) {
  console.log("Usage:");
  console.log("  npm run fetch-song -- search <query>");
  console.log("  npm run fetch-song -- <beatmapsetId> [diff-name-substring]");
  process.exit(1);
}

try {
  if (cmd === "search") {
    await cmdSearch(arg2);
  } else if (/^\d+$/.test(cmd)) {
    await cmdInstall(cmd, arg2);
  } else {
    console.error(`Unknown command: ${cmd}`);
    console.error(`Run with no args to see usage.`);
    process.exit(1);
  }
} catch (err) {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
}
