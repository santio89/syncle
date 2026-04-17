#!/usr/bin/env node
/**
 * Reads songs.config.json and writes public/songs/manifest.json — the file
 * the runtime fetches to know which song to play today and where to get
 * its audio + chart.
 *
 * Two output modes, picked automatically:
 *
 *   remote  release.owner/repo/tag is set, GitHub API is reachable, and every
 *           song's `audio` + `chart` filenames exist as assets in that
 *           release. Manifest URLs point at GitHub's release CDN.
 *
 *   local   no release configured, the API call failed, or one or more
 *           assets are missing from the release. Manifest URLs point at
 *           /songs/<...> in your /public folder, so dev still works without
 *           any GitHub setup.
 *
 * Run manually:   npm run build:manifest
 * Runs automatically before `next dev` and `next build` via package.json.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = join(ROOT, "songs.config.json");
const MANIFEST_PATH = join(ROOT, "public", "songs", "manifest.json");

const log = (msg) => console.log(`[manifest] ${msg}`);
const warn = (msg) => console.warn(`[manifest] WARN: ${msg}`);

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`songs.config.json not found at ${CONFIG_PATH}`);
  }
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
}

/** Fetch the release metadata + asset list from the GitHub REST API. */
async function fetchReleaseAssets({ owner, repo, tag }) {
  const url = `https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`;
  const headers = {
    "User-Agent": "syncle-build",
    Accept: "application/vnd.github+json",
  };
  // Optional auth bumps the rate limit from 60/hr to 5000/hr. Useful if you
  // build locally a lot or do many CI rebuilds per hour.
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub API ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  /** @type {Map<string, string>} name → browser_download_url */
  const map = new Map();
  for (const a of data.assets || []) {
    map.set(a.name, a.browser_download_url);
  }
  return map;
}

/** URL-encode each path segment, keep slashes. */
function encodePath(p) {
  return p.split("/").map(encodeURIComponent).join("/");
}

/** Local public/-relative URL for a config-relative path. */
function localUrl(relPath) {
  return `/songs/${encodePath(relPath)}`;
}

/** Last segment of a slash-separated path. */
function basename(p) {
  return posix.basename(p);
}

function isPlaceholderRelease(rel) {
  return (
    !rel ||
    !rel.owner ||
    !rel.repo ||
    !rel.tag ||
    String(rel.owner).startsWith("YOUR_")
  );
}

async function main() {
  const cfg = loadConfig();

  /** @type {Map<string, string> | null} */
  let assetMap = null;
  let mode = "local";
  let modeReason = "no release configured in songs.config.json";

  if (!isPlaceholderRelease(cfg.release)) {
    const { owner, repo, tag } = cfg.release;
    try {
      log(`fetching release ${owner}/${repo}@${tag}...`);
      assetMap = await fetchReleaseAssets({ owner, repo, tag });
      mode = "remote";
      modeReason = `${assetMap.size} asset(s) in release`;
    } catch (err) {
      warn(`could not fetch release: ${err.message}`);
      warn("falling back to local mode (public/songs/...)");
      modeReason = `API failed: ${err.message}`;
    }
  }

  const songs = {};
  let skipped = 0;

  for (const [id, meta] of Object.entries(cfg.songs || {})) {
    const audioPath = meta.audio ?? `${id}.mp3`;
    const chartPath = meta.chart ?? `${id}.osu`;

    let audioUrl;
    let chartUrl;

    if (mode === "remote" && assetMap) {
      const audioName = basename(audioPath);
      const chartName = basename(chartPath);
      audioUrl = assetMap.get(audioName);
      chartUrl = assetMap.get(chartName);
      if (!audioUrl || !chartUrl) {
        warn(
          `song "${id}": asset(s) missing in release ` +
            `(need "${audioName}" + "${chartName}") — skipping`,
        );
        skipped++;
        continue;
      }
    } else {
      audioUrl = localUrl(audioPath);
      chartUrl = localUrl(chartPath);
    }

    songs[id] = {
      id,
      title: meta.title ?? id,
      artist: meta.artist ?? "Unknown",
      ...(meta.year != null ? { year: meta.year } : {}),
      audioUrl,
      chartUrl,
    };
  }

  // Pool entries are runtime-only — the build script just passes them through.
  // Each entry: { id: number, diff?: string, label?: string }
  const pool = Array.isArray(cfg.pool)
    ? cfg.pool
        .filter((e) => e && typeof e.id === "number")
        .map((e) => ({
          id: e.id,
          ...(e.diff ? { diff: String(e.diff) } : {}),
          ...(e.label ? { label: String(e.label) } : {}),
        }))
    : [];

  const pickStrategy = cfg.pickStrategy === "random" ? "random" : "daily";

  const manifest = {
    generatedAt: new Date().toISOString(),
    mode,
    modeReason,
    pickStrategy,
    schedule: Array.isArray(cfg.schedule) ? cfg.schedule : [],
    songs,
    ...(pool.length > 0 ? { pool } : {}),
  };

  mkdirSync(dirname(MANIFEST_PATH), { recursive: true });
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");

  const summary =
    `wrote ${Object.keys(songs).length} local song(s) + ` +
    `${pool.length} pool entr${pool.length === 1 ? "y" : "ies"}, ` +
    `mode=${mode}, pickStrategy=${pickStrategy}`;
  log(skipped ? `${summary}, ${skipped} skipped` : summary);
}

main().catch((err) => {
  console.error("[manifest] FAILED:", err);
  process.exit(1);
});
