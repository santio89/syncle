/**
 * Server-side song catalog fetcher for multiplayer host pickers.
 *
 * Hits the same public osu!mania search APIs the client uses for solo random
 * picks (lib/game/oszFetcher.ts) but from the server so:
 *   - host doesn't burn their own bandwidth on a 50-card list,
 *   - we can centrally rate-limit / cache results,
 *   - the same item set is shown to everyone in the room (host previews
 *     the title + artist before clicking "Start").
 */

import { CatalogItem } from "@/lib/multi/protocol";

interface SearchSource {
  name: string;
  url: (page: number, ps: number) => string;
  extract: (json: unknown) => unknown[];
}

const SEARCH_SOURCES: SearchSource[] = [
  {
    name: "nerinyan.moe",
    url: (page, ps) =>
      `https://api.nerinyan.moe/search?m=3&s=ranked&ps=${ps}&p=${page}`,
    extract: (j) => (Array.isArray(j) ? j : []),
  },
  {
    name: "osu.direct",
    url: (page, ps) =>
      `https://osu.direct/api/v2/search?mode=3&status=1&amount=${ps}&offset=${page * ps}`,
    extract: (j: any) =>
      Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : [],
  },
  {
    // Same osu!-v2 response shape as nerinyan, so normalize() works
    // unchanged. We already use catboy as a download mirror — wiring up
    // its search side gives us 3-way redundancy without a new schema.
    name: "catboy.best",
    url: (page, ps) =>
      `https://catboy.best/api/v2/search?m=3&s=ranked&ps=${ps}&p=${page}`,
    extract: (j) => (Array.isArray(j) ? j : []),
  },
];

const PAGE_WINDOW = 30;
const PAGE_SIZE = 50;
const FETCH_TIMEOUT_MS = 8_000;
// Target catalog size. Mirrors cap a single page at PAGE_SIZE (50)
// items, and ranking-quality filtering (4K mania only) typically drops
// 10-30 % of those, so reaching this target requires walking 3-4
// consecutive pages from a random offset and deduping by id.
//
// Wire cost is still trivial: ~100 bytes per CatalogItem → ~10 KB per
// room. The expensive .osz / cover / chart bytes only ever land for
// the ONE song the host actually clicks (probeSongModes() warms the
// per-set cache; loadSongById() reuses it for "Start match").
const MAX_CATALOG_ITEMS = 100;
// Hard cap on consecutive pages walked per source before giving up.
// Protects against a sparse mirror or a malformed page that never
// contributes new items — without this we could spin forever fetching
// duplicates of the same `beatmapsetId`s.
const MAX_PAGES_PER_SOURCE = 6;

/**
 * Fetch up to `MAX_CATALOG_ITEMS` ranked osu!mania 4K beatmapsets from a
 * public search mirror.
 *
 * Strategy:
 *   - Pick mirrors in random order so the load spreads and a single
 *     bad mirror doesn't always serve everyone.
 *   - Per mirror, start from a random page in `PAGE_WINDOW` and walk
 *     consecutive pages until we hit the target count, run out of
 *     pages (an empty page = mirror has no more results from this
 *     offset), or stop making progress for two pages in a row (sparse
 *     4K mania pool past the random offset).
 *   - Dedupe by `beatmapsetId` so a mirror returning overlapping
 *     pages doesn't inflate the count with repeats.
 *   - Fall through to the next mirror if the current one yields zero
 *     items across all attempts; surface a combined error if all
 *     mirrors fail.
 */
export async function fetchCatalog(): Promise<CatalogItem[]> {
  const sources = [...SEARCH_SOURCES].sort(() => Math.random() - 0.5);
  const errors: string[] = [];

  for (const src of sources) {
    const startPage = Math.floor(Math.random() * PAGE_WINDOW);
    const seen = new Set<number>();
    const items: CatalogItem[] = [];
    let consecutiveEmpty = 0;

    for (
      let pageOffset = 0;
      pageOffset < MAX_PAGES_PER_SOURCE && items.length < MAX_CATALOG_ITEMS;
      pageOffset++
    ) {
      const page = startPage + pageOffset;
      const url = src.url(page, PAGE_SIZE);
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          headers: { accept: "application/json" },
          signal: ac.signal,
        });
        if (!res.ok) {
          errors.push(`${src.name} p${page}: HTTP ${res.status}`);
          // Stop walking pages on this source after a hard error;
          // continuation is unlikely to recover. Fall through to the
          // next mirror.
          break;
        }
        const json = await res.json();
        const sets = src.extract(json);
        if (sets.length === 0) {
          // Empty page = exhausted this offset window; continuing is
          // pointless. Treat as end-of-mirror, not a failure.
          break;
        }
        const before = items.length;
        for (const raw of sets) {
          const item = normalize(raw, src.name);
          if (!item || seen.has(item.beatmapsetId)) continue;
          seen.add(item.beatmapsetId);
          items.push(item);
          if (items.length >= MAX_CATALOG_ITEMS) break;
        }
        if (items.length === before) {
          // No new items from this page — either entirely duplicates
          // or all filtered out. Two such pages in a row means the
          // remaining offset window isn't going to contribute, so cut
          // losses and either return what we have or fall through.
          consecutiveEmpty++;
          if (consecutiveEmpty >= 2) break;
        } else {
          consecutiveEmpty = 0;
        }
      } catch (err: any) {
        const msg =
          err?.name === "AbortError" ? "timeout" : err?.message ?? String(err);
        errors.push(`${src.name} p${page}: ${msg}`);
        // Network error mid-walk: bail to the next mirror rather than
        // retrying — the per-page timeout is already 8 s, retrying
        // here would push the host's perceived "loading catalog" wait
        // past 30 s.
        break;
      } finally {
        clearTimeout(timer);
      }
    }

    if (items.length > 0) return items;
    if (errors.length === 0 || !errors[errors.length - 1].startsWith(src.name)) {
      errors.push(`${src.name}: 0 4K mania results across walked pages`);
    }
  }

  throw new Error(
    `No catalog could be fetched from any source:\n  ${errors.join("\n  ")}`,
  );
}

function normalize(raw: any, source: string): CatalogItem | null {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.id !== "number") return null;
  // Filter to sets that have at least one 4K mania difficulty so the host
  // doesn't pick something that fails to load for everyone.
  const beats = Array.isArray(raw.beatmaps) ? raw.beatmaps : [];
  const fourKBeats = beats.filter(
    (b: any) =>
      (b?.mode_int === 3 || b?.mode === 3 || b?.mode === "mania") &&
      Math.round(Number(b?.cs)) === 4,
  );
  if (fourKBeats.length === 0) return null;
  // Track duration is identical across difficulties of the same beatmapset
  // (they're all charts of the same song), but we still take the max as a
  // defensive guard against truncated diffs / odd mirror responses. Prefer
  // `total_length` (full track), fall back to `hit_length` (time between
  // first and last hit object) if the mirror omits the former. Both fields
  // are seconds in the standard osu API. Caps at a sane upper bound so a
  // junk value (e.g. -1, NaN, 99999) can't blow up the formatter.
  let durationSec: number | undefined;
  for (const b of fourKBeats) {
    const len = Number(b?.total_length ?? b?.hit_length);
    if (Number.isFinite(len) && len > 0 && len < 60 * 60) {
      durationSec = Math.max(durationSec ?? 0, Math.round(len));
    }
  }
  return {
    beatmapsetId: raw.id,
    title: typeof raw.title === "string" ? raw.title : "Untitled",
    artist: typeof raw.artist === "string" ? raw.artist : "Unknown",
    source,
    ...(durationSec !== undefined ? { durationSec } : {}),
  };
}
