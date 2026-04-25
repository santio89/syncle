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
import { ChartMode, MODE_ORDER, assignBucket } from "@/lib/game/difficulty";

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
    // unchanged. We already use catboy as a download mirror - wiring up
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
// contributes new items - without this we could spin forever fetching
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
          // No new items from this page - either entirely duplicates
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
        // retrying - the per-page timeout is already 8 s, retrying
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

// ---------------------------------------------------------------------------
// Text-search catalog (paginated)
// ---------------------------------------------------------------------------

/**
 * Per-mirror URL builders for *text-query* search. Same three mirrors as
 * `SEARCH_SOURCES`, but with the relevant `q=` / `query=` parameter
 * appended and pagination expressed in the mirror's native form. Kept
 * separate from the random-browse builders so changes to either mode
 * don't accidentally cross-contaminate (random-browse hits its own
 * page-window math, search uses the host-supplied page directly).
 */
const QUERY_SOURCES: Array<{
  name: string;
  url: (query: string, page: number, ps: number) => string;
  extract: (json: unknown) => unknown[];
}> = [
  {
    name: "nerinyan.moe",
    url: (q, page, ps) =>
      `https://api.nerinyan.moe/search?m=3&s=ranked&ps=${ps}&p=${page}&q=${encodeURIComponent(q)}`,
    extract: (j) => (Array.isArray(j) ? j : []),
  },
  {
    // catboy uses the same v2 schema; appending `q=` switches it from
    // browse to search mode without any other parameter changes.
    name: "catboy.best",
    url: (q, page, ps) =>
      `https://catboy.best/api/v2/search?m=3&s=ranked&ps=${ps}&p=${page}&q=${encodeURIComponent(q)}`,
    extract: (j) => (Array.isArray(j) ? j : []),
  },
  {
    // osu.direct's v2 search supports `query=` (alias `q=` works on
    // some builds; we use the documented form). Pagination uses
    // offset/amount instead of page/ps so we translate `page` → offset.
    name: "osu.direct",
    url: (q, page, ps) =>
      `https://osu.direct/api/v2/search?mode=3&status=1&amount=${ps}&offset=${page * ps}&query=${encodeURIComponent(q)}`,
    extract: (j: any) =>
      Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : [],
  },
];

/** Default upstream page size (matches the mirrors' natural pagination). */
const SEARCH_PAGE_SIZE = 50;
/** Max pages a single query may walk. Cheap guard against runaway requests. */
export const SEARCH_MAX_PAGES = 20;
/**
 * Max pages a no-query browse may walk. Higher than SEARCH_MAX_PAGES
 * because browse-mode pagination is the primary discovery surface
 * (without it, a host who doesn't know what to search for can only
 * see the most-recently-ranked 50 sets) - letting them go ~5 000 sets
 * deep covers most of the practical "I'll know it when I see it"
 * range without inviting infinite scrolling against the upstream.
 */
export const BROWSE_MAX_PAGES = 100;

/**
 * How many consecutive upstream pages we walk per LOGICAL page when a
 * bucket filter is active.
 *
 * Why this exists:
 *   Without filtering, one upstream page (50 sets) ≈ one logical
 *   page - the host clicks Next, we ask the mirror for the next 50,
 *   show them. Done.
 *
 *   With filtering (e.g. only "easy"), only a fraction of those 50
 *   sets ship the requested tier - typically 15-40 %, sometimes
 *   single digits for rarer tiers like Expert. So a naive 1:1 mapping
 *   leaves the host staring at half-empty lists (5-10 rows where
 *   they expect ~50) and clicking Next over and over to see more
 *   matches that exist a couple of upstream pages further in.
 *
 *   Walking a BLOCK of upstream pages per logical page is the
 *   simplest fix that keeps the client API stable (still page-N →
 *   page-N+1 increments, no cursor state). With BLOCK=4 we examine
 *   200 candidates per logical page, so even a 10 %-survival filter
 *   yields ~20 matches per page instead of 5.
 *
 * Why deterministic block math (page * BLOCK) instead of an
 * adaptive "walk until full":
 *   - Adaptive walking can early-stop, which means the next logical
 *     page would have to start at a non-block-aligned upstream offset
 *     to avoid skipping rows. That requires a server-tracked cursor
 *     (or a client-stored cursor stack for Prev), both of which add
 *     state and complicate caching.
 *   - Block math: logical page N always maps to upstream pages
 *     [N*BLOCK, N*BLOCK+BLOCK-1]. Cache key (page, bucket) stays
 *     stable, Prev/Next math stays trivial, and no rows are ever
 *     skipped between blocks.
 *
 * Cost: when filtering is active, each Next click triggers up to
 * BLOCK upstream fetches instead of 1. With the existing 5-minute
 * per-room cache and mirror responses in the 100-300 ms range, the
 * first visit to a filtered page takes ~1 second (acceptable behind
 * the existing "Searching…" affordance), subsequent navigation hits
 * cache.
 */
const BUCKET_FILTER_PAGE_BLOCK = 4;

/**
 * Walk `BUCKET_FILTER_PAGE_BLOCK` consecutive upstream pages on a
 * single mirror, normalize + bucket-filter every result, dedupe by
 * `beatmapsetId`, and return the union.
 *
 * Mirror-locking: takes a SINGLE source for the whole walk so prev/
 * next pagination stays consistent (page-N+1 must show "the next
 * slice of what page-N showed", which only holds within a single
 * mirror's view of the world). Caller is responsible for picking
 * the source - typically by trying the source list in order and
 * locking to the first one that returns a successful first
 * sub-page.
 *
 * Returns:
 *   - `items`: union of items across all walked sub-pages, deduped
 *   - `hasMore`: true iff the LAST walked sub-page returned a full
 *     upstream slice (`sets.length >= pageSize`). That's the same
 *     "is there probably more" heuristic we use unfiltered, just
 *     applied to the last sub-page in the block - if it was full,
 *     the next block likely has more rows; if it was partial, we've
 *     hit the end of the mirror's view for this query.
 *
 * Re-throws iff the FIRST sub-page errors - that means this mirror
 * gave us nothing usable, so the caller should fall through to the
 * next mirror. A mid-walk error (sub-page 2+) is swallowed: we keep
 * whatever rows the earlier sub-pages already produced and mark
 * `hasMore: false` since we can't honestly know what comes next.
 */
async function walkBucketFilteredBlock(opts: {
  startPage: number;
  pageSize: number;
  bucket: ChartMode;
  fetchPage: (pageIndex: number) => Promise<unknown[]>;
  sourceName: string;
}): Promise<{ items: CatalogItem[]; hasMore: boolean }> {
  const { startPage, pageSize, bucket, fetchPage, sourceName } = opts;
  const seen = new Set<number>();
  const items: CatalogItem[] = [];
  let lastSubPageWasFull = false;

  for (let i = 0; i < BUCKET_FILTER_PAGE_BLOCK; i++) {
    const upstreamPage = startPage + i;
    let sets: unknown[];
    try {
      sets = await fetchPage(upstreamPage);
    } catch (err: any) {
      if (i === 0) throw err;
      // Mid-walk failure: keep what we have, mark "no more" since
      // we can't honestly know what comes next without the rest of
      // the block.
      lastSubPageWasFull = false;
      break;
    }

    if (sets.length === 0) {
      // Empty upstream sub-page = end of this mirror's results for
      // the current query. Don't walk further.
      lastSubPageWasFull = false;
      break;
    }

    for (const raw of sets) {
      const item = normalize(raw, sourceName);
      if (!item || seen.has(item.beatmapsetId)) continue;
      if (!item.availableBuckets?.includes(bucket)) continue;
      seen.add(item.beatmapsetId);
      items.push(item);
    }

    lastSubPageWasFull = sets.length >= pageSize;
    if (!lastSubPageWasFull) {
      // Partial upstream sub-page = mirror has nothing past this
      // offset. No point walking the rest of the block.
      break;
    }
  }

  return { items, hasMore: lastSubPageWasFull };
}

/**
 * Sort orders we expose for the no-query browse view. The mirror
 * implementations differ in detail (some accept `sort=ranked_desc`,
 * others infer ordering from `s=ranked` alone) but every value here
 * is a no-op-safe parameter on every mirror - the worst case is the
 * mirror ignores it and you get its default ordering, which for the
 * `s=ranked / status=1` filter we always pass is "most recently
 * ranked first" everywhere we tested.
 *
 * Default is `ranked_desc` because that's what the host wants 90 %
 * of the time when they open the browser ("show me what's new").
 * Other values reserved for the Pass 2 sort dropdown.
 */
export const BROWSE_SORT_VALUES = [
  "ranked_desc",
  "ranked_asc",
  "plays_desc",
  "rating_desc",
] as const;
export type BrowseSort = (typeof BROWSE_SORT_VALUES)[number];

const BROWSE_SOURCES: Array<{
  name: string;
  url: (page: number, ps: number, sort: BrowseSort) => string;
  extract: (json: unknown) => unknown[];
}> = [
  {
    name: "nerinyan.moe",
    url: (page, ps, sort) =>
      `https://api.nerinyan.moe/search?m=3&s=ranked&ps=${ps}&p=${page}&sort=${sort}`,
    extract: (j) => (Array.isArray(j) ? j : []),
  },
  {
    name: "catboy.best",
    url: (page, ps, sort) =>
      `https://catboy.best/api/v2/search?m=3&s=ranked&ps=${ps}&p=${page}&sort=${sort}`,
    extract: (j) => (Array.isArray(j) ? j : []),
  },
  {
    name: "osu.direct",
    url: (page, ps, sort) =>
      `https://osu.direct/api/v2/search?mode=3&status=1&amount=${ps}&offset=${page * ps}&sort=${sort}`,
    extract: (j: any) =>
      Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : [],
  },
];

export interface SearchCatalogResult {
  items: CatalogItem[];
  /**
   * True iff the upstream page came back full (== requested page size),
   * which heuristically indicates "there's probably more". The mirrors
   * we use don't reliably return total counts, so this is the cleanest
   * signal we can give the UI for showing/hiding a Next button without
   * a second probe request.
   */
  hasMore: boolean;
  /** Page index we actually fetched (echoed for the client to anchor pagination on). */
  page: number;
  /** Effective page size after applying SEARCH_PAGE_SIZE clamp. */
  pageSize: number;
  /** Mirror that delivered this page (diagnostic; surfaced in card metadata too). */
  source: string;
}

/**
 * Fetch ONE page of text-query catalog results.
 *
 * Strategy:
 *   - Try mirrors in fixed order (nerinyan → catboy → osu.direct).
 *     Unlike the random-browse path we DON'T shuffle, because pagination
 *     consistency matters for the UI: page 2 must show "the next slice
 *     of what page 1 showed", which only works if both calls hit the
 *     same mirror. Locking to the first responding mirror per call gives
 *     us that without per-room session state.
 *   - First mirror that returns a 200 with a non-empty (or definitively
 *     empty) body wins; transient errors bump to the next mirror. This
 *     mirrors the behavior `fetchCatalog` already uses for browse but
 *     applied per-page instead of per-session.
 *   - Apply the same 4K-mania filter + dedupe pass `normalize()` does,
 *     so the UI never sees a row it can't actually load.
 *
 * Caveats worth knowing:
 *   - Different mirrors index differently - searching "spectre" on
 *     nerinyan vs catboy can return different sets in different
 *     orders. Locking to one mirror per call sidesteps this within
 *     a single browse session.
 *   - `hasMore` is a *heuristic*. A mirror returning exactly `pageSize`
 *     items can still be the last page if that page is full. The UI
 *     should disable Next on a subsequent empty page rather than
 *     blindly trusting the flag - same way GitHub/Reddit handle it.
 */
export async function searchCatalogPage(opts: {
  query: string;
  page: number;
  pageSize?: number;
  /**
   * Optional Syncle bucket filter - when set, the returned `items` are
   * restricted to sets whose `availableBuckets` includes this tier.
   *
   * When this is set, we walk a BLOCK of `BUCKET_FILTER_PAGE_BLOCK`
   * consecutive upstream pages per logical page (instead of 1:1) so
   * the post-filter slice is large enough to actually fill the host's
   * list. See `BUCKET_FILTER_PAGE_BLOCK` for the why.
   *
   * Logical-page math under filter:
   *   logical page N → upstream pages [N*BLOCK, N*BLOCK+BLOCK-1]
   *
   * `hasMore` under filter reflects "is there a next BLOCK", not "is
   * the current upstream sub-page full" - i.e. it's true iff the LAST
   * sub-page we walked came back full at the upstream level.
   */
  bucket?: ChartMode;
}): Promise<SearchCatalogResult> {
  const query = opts.query.trim();
  if (!query) {
    throw new Error("searchCatalogPage requires a non-empty query");
  }
  const pageSize = Math.max(
    1,
    Math.min(SEARCH_PAGE_SIZE, Math.floor(opts.pageSize ?? SEARCH_PAGE_SIZE)),
  );
  // Clamp the LOGICAL page so `page * BLOCK` (when filtering) can't
  // walk past SEARCH_MAX_PAGES on the upstream. Without filter, BLOCK
  // is effectively 1 so the existing bound applies.
  const maxLogicalPage = opts.bucket
    ? Math.max(0, Math.floor(SEARCH_MAX_PAGES / BUCKET_FILTER_PAGE_BLOCK) - 1)
    : SEARCH_MAX_PAGES - 1;
  const page = Math.max(0, Math.min(maxLogicalPage, Math.floor(opts.page)));

  const errors: string[] = [];
  for (const src of QUERY_SOURCES) {
    const fetchPage = async (upstreamPage: number): Promise<unknown[]> => {
      const url = src.url(query, upstreamPage, pageSize);
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          headers: { accept: "application/json" },
          signal: ac.signal,
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const json = await res.json();
        return src.extract(json);
      } finally {
        clearTimeout(timer);
      }
    };

    try {
      if (opts.bucket) {
        const startPage = page * BUCKET_FILTER_PAGE_BLOCK;
        const { items, hasMore } = await walkBucketFilteredBlock({
          startPage,
          pageSize,
          bucket: opts.bucket,
          fetchPage,
          sourceName: src.name,
        });
        return {
          items,
          hasMore,
          page,
          pageSize,
          source: src.name,
        };
      }

      // Unfiltered: 1 upstream page = 1 logical page (unchanged).
      const sets = await fetchPage(page);
      const seen = new Set<number>();
      const items: CatalogItem[] = [];
      for (const raw of sets) {
        const item = normalize(raw, src.name);
        if (!item || seen.has(item.beatmapsetId)) continue;
        seen.add(item.beatmapsetId);
        items.push(item);
      }
      // Treat a 200-OK with zero raw rows as a definitive "no results"
      // for THIS mirror - return immediately rather than falling
      // through, so the UI can render an honest empty state instead of
      // pulling identical empty pages from the next two mirrors.
      const upstreamWasEmpty = sets.length === 0;
      const hasMore = !upstreamWasEmpty && sets.length >= pageSize;
      return {
        items,
        hasMore,
        page,
        pageSize,
        source: src.name,
      };
    } catch (err: any) {
      const msg =
        err?.name === "AbortError" ? "timeout" : err?.message ?? String(err);
      errors.push(`${src.name} q="${query}" p${page}: ${msg}`);
    }
  }

  throw new Error(
    `Catalog search failed for "${query}" page ${page}:\n  ${errors.join("\n  ")}`,
  );
}

/**
 * Fetch ONE page of the no-query browse view.
 *
 * Mechanically identical to `searchCatalogPage` (mirror fan-out, dedupe,
 * 4K filter via `normalize`, hasMore heuristic) - but with no `q=` and
 * an explicit sort order baked in. Default `ranked_desc` matches the
 * host's most common intent when opening the browser ("show me what's
 * new"). Mirrors are tried in fixed order so pagination consistency
 * holds within a session: page 2 is the next slice of the same mirror
 * that served page 1, not a different mirror's page 2.
 */
export async function browseCatalogPage(opts: {
  page: number;
  pageSize?: number;
  sort?: BrowseSort;
  /**
   * Optional Syncle bucket filter - same semantics as
   * `searchCatalogPage.bucket`. When set, walks a BLOCK of upstream
   * pages per logical page so the post-filter slice is large enough
   * to actually fill the host's list.
   */
  bucket?: ChartMode;
}): Promise<SearchCatalogResult> {
  const pageSize = Math.max(
    1,
    Math.min(SEARCH_PAGE_SIZE, Math.floor(opts.pageSize ?? SEARCH_PAGE_SIZE)),
  );
  const maxLogicalPage = opts.bucket
    ? Math.max(0, Math.floor(BROWSE_MAX_PAGES / BUCKET_FILTER_PAGE_BLOCK) - 1)
    : BROWSE_MAX_PAGES - 1;
  const page = Math.max(0, Math.min(maxLogicalPage, Math.floor(opts.page)));
  // Validate the sort enum BEFORE building a URL so a mirror never
  // sees a bogus param (some mirrors 400 on unknown sort values
  // instead of ignoring them).
  const sort: BrowseSort =
    opts.sort && BROWSE_SORT_VALUES.includes(opts.sort)
      ? opts.sort
      : "ranked_desc";

  const errors: string[] = [];
  for (const src of BROWSE_SOURCES) {
    const fetchPage = async (upstreamPage: number): Promise<unknown[]> => {
      const url = src.url(upstreamPage, pageSize, sort);
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          headers: { accept: "application/json" },
          signal: ac.signal,
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const json = await res.json();
        return src.extract(json);
      } finally {
        clearTimeout(timer);
      }
    };

    try {
      if (opts.bucket) {
        const startPage = page * BUCKET_FILTER_PAGE_BLOCK;
        const { items, hasMore } = await walkBucketFilteredBlock({
          startPage,
          pageSize,
          bucket: opts.bucket,
          fetchPage,
          sourceName: src.name,
        });
        return {
          items,
          hasMore,
          page,
          pageSize,
          source: src.name,
        };
      }

      const sets = await fetchPage(page);
      const seen = new Set<number>();
      const items: CatalogItem[] = [];
      for (const raw of sets) {
        const item = normalize(raw, src.name);
        if (!item || seen.has(item.beatmapsetId)) continue;
        seen.add(item.beatmapsetId);
        items.push(item);
      }
      const upstreamWasEmpty = sets.length === 0;
      const hasMore = !upstreamWasEmpty && sets.length >= pageSize;
      return {
        items,
        hasMore,
        page,
        pageSize,
        source: src.name,
      };
    } catch (err: any) {
      const msg =
        err?.name === "AbortError" ? "timeout" : err?.message ?? String(err);
      errors.push(`${src.name} browse(${sort}) p${page}: ${msg}`);
    }
  }

  throw new Error(
    `Catalog browse failed for sort="${sort}" page ${page}:\n  ${errors.join("\n  ")}`,
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
  // Compute the Syncle buckets present in this set BEFORE the .osz is
  // ever downloaded. We don't have the parsed notes at this point, only
  // the upstream metadata, so we approximate `nps` using the mirror's
  // hit-object counts divided by `hit_length` (= time between first
  // and last hit object). That's the same density definition the
  // on-disk path uses post-parse, so the buckets agree for ~99 % of
  // sets when the count fields are present.
  //
  // Field-name caveat: the modern osu! API v2 (and every mirror that
  // proxies it: nerinyan.moe, osu.direct, catboy.best) uses the
  // PLURAL v2 names - `count_circles`, `count_sliders`,
  // `count_spinners`. The legacy v1 API used the SINGULAR
  // `count_normal`, `count_slider`, `count_spinner`. We accept both
  // shapes (v2 first, v1 fallback) so any mirror's response normalizes
  // correctly. Without this, the v1 keys would resolve to undefined
  // on every modern mirror, every diff would have nps=0, and every
  // set would mis-bucket to Easy (which is what we'd shipped before
  // the field name fix).
  //
  // When a diff exposes neither count shape, `assignBucket` falls
  // back to mapper-name classification (see the function's doc) -
  // strictly better than the previous behavior of dumping everything
  // into Easy, since the mapper's "Hard"/"Insane"/"Lunatic" naming is
  // a strong signal even without note counts.
  //
  // Buckets are de-duped + sorted into MODE_ORDER for deterministic
  // wire output (cache-friendly + UI-friendly: chip always renders
  // easy-then-expert order even on mirrors that list diffs out of order).
  const bucketSet = new Set<ChartMode>();
  for (const b of fourKBeats) {
    const version = typeof b?.version === "string" ? b.version : "";
    const circles = Number(b?.count_circles ?? b?.count_normal ?? 0);
    const sliders = Number(b?.count_sliders ?? b?.count_slider ?? 0);
    const spinners = Number(b?.count_spinners ?? b?.count_spinner ?? 0);
    const counts = circles + sliders + spinners;
    const dur = Number(b?.hit_length ?? b?.total_length ?? 0);
    // We ALWAYS try to bucket - even when counts/duration are missing
    // - because `assignBucket` handles the no-density case via the
    // mapper name. We just pass `0` as nps in that fallback path,
    // which the function reads as "trust the name only".
    const nps =
      Number.isFinite(counts) && Number.isFinite(dur) && dur > 0
        ? counts / dur
        : 0;
    bucketSet.add(assignBucket(version, nps));
  }
  const availableBuckets = MODE_ORDER.filter((m) => bucketSet.has(m));
  return {
    beatmapsetId: raw.id,
    title: typeof raw.title === "string" ? raw.title : "Untitled",
    artist: typeof raw.artist === "string" ? raw.artist : "Unknown",
    source,
    ...(durationSec !== undefined ? { durationSec } : {}),
    ...(availableBuckets.length > 0 ? { availableBuckets } : {}),
  };
}
