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
];

const PAGE_WINDOW = 30;
const PAGE_SIZE = 50;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_CATALOG_ITEMS = 24;

/**
 * Fetch a fresh page of ranked osu!mania 4K beatmapsets from a public search
 * mirror. Sources are tried in random order to spread load and survive a
 * single mirror hiccup. Returns up to `MAX_CATALOG_ITEMS` 4K-eligible items.
 */
export async function fetchCatalog(): Promise<CatalogItem[]> {
  const sources = [...SEARCH_SOURCES].sort(() => Math.random() - 0.5);
  const errors: string[] = [];

  for (const src of sources) {
    const page = Math.floor(Math.random() * PAGE_WINDOW);
    const url = src.url(page, PAGE_SIZE);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { accept: "application/json" },
        signal: ac.signal,
      });
      if (!res.ok) {
        errors.push(`${src.name}: HTTP ${res.status}`);
        continue;
      }
      const json = await res.json();
      const sets = src.extract(json);
      const items: CatalogItem[] = [];
      for (const raw of sets) {
        const item = normalize(raw, src.name);
        if (!item) continue;
        items.push(item);
        if (items.length >= MAX_CATALOG_ITEMS) break;
      }
      if (items.length === 0) {
        errors.push(`${src.name}: page ${page} had 0 4K mania results`);
        continue;
      }
      return items;
    } catch (err: any) {
      const msg = err?.name === "AbortError" ? "timeout" : err?.message ?? String(err);
      errors.push(`${src.name}: ${msg}`);
    } finally {
      clearTimeout(timer);
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
  const has4K = beats.some(
    (b: any) =>
      (b?.mode_int === 3 || b?.mode === 3 || b?.mode === "mania") &&
      Math.round(Number(b?.cs)) === 4,
  );
  if (!has4K) return null;
  return {
    beatmapsetId: raw.id,
    title: typeof raw.title === "string" ? raw.title : "Untitled",
    artist: typeof raw.artist === "string" ? raw.artist : "Unknown",
    source,
  };
}
