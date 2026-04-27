/**
 * Route-chunk prefetch helpers.
 *
 * The two heavy routes - `/play` (single-player game) and `/multi`
 * (multiplayer entry / room shell) - both gate their largest payloads
 * behind `next/dynamic({ ssr: false })` because those payloads pull in
 * browser-only APIs (AudioContext + Canvas for `/play`, socket.io-client
 * for `/multi`). Without that gating, the routes would either fail SSR
 * outright or balloon the homepage's first-load JS for every visitor
 * who never clicks Play / Multiplayer.
 *
 * The trade-off: the dynamic chunk isn't requested until the destination
 * route actually mounts, i.e. AFTER the user clicks. Even on a fast
 * connection that's a perceptible 100-300 ms gap (much worse on a cold
 * dev server, which compiles the route on demand). The route shell
 * paints instantly thanks to `loading: () => <Skeleton/>`, but the
 * meaningful UI - the highway, the join form - waits on the chunk.
 *
 * This module closes that gap with two layered warm-up strategies:
 *
 *   1. **Idle prefetch** (`schedulePrefetchAll`): once the homepage is
 *      interactive and the browser has spare cycles, kick off the
 *      `import()` calls for both heavy chunks. The browser caches them
 *      as soon as they arrive; if the user later clicks Play, the chunk
 *      is already in memory and the route mounts the real component
 *      immediately. We use `requestIdleCallback` (with a `setTimeout`
 *      fallback for Safari, which still doesn't ship it) so the
 *      prefetch never competes with first-paint work.
 *
 *   2. **Intent prefetch** (`prefetchOnIntent`): mouse / touch / focus
 *      attached to any Link or button that navigates to a heavy route.
 *      The earliest signal of intent (pointer hovering over the CTA,
 *      keyboard focus landing on it) triggers an immediate `import()`.
 *      For users on slow connections where the idle prefetch is still
 *      in flight when they click - or who land deep in the site without
 *      passing through the homepage - hover/focus is a second chance
 *      to start the download before the click commits.
 *
 * Both strategies dedupe through webpack's module cache + the local
 * `started` flags below: calling either prefetcher repeatedly is free
 * after the first successful kick-off (the `import()` returns the same
 * cached promise, and the flag short-circuits even creating that
 * promise on subsequent calls).
 *
 * NB: this file deliberately ships ZERO transitive imports of the
 * heavy modules. It only references them via dynamic `import()` strings
 * inside function bodies, so importing this module from the homepage
 * does NOT pull `Game.tsx` or `MultiEntryClient.tsx` into the home
 * route's chunk. The whole point is to stay code-split.
 */

let playStarted = false;
let multiStarted = false;

/**
 * Kick off the `/play` route's heavy chunk (`components/Game.tsx` plus
 * its audio engine + renderer + chart parser dependencies). Idempotent:
 * the first call starts the fetch, every subsequent call is a no-op.
 *
 * The chunk path string here MUST match the one in `app/play/page.tsx`'s
 * `dynamic(() => import("@/components/Game"))` literal so webpack
 * unifies the two import sites onto the same chunk. Otherwise we'd
 * end up shipping the same code twice in two separately-named chunks.
 */
export function prefetchPlayChunk(): void {
  if (playStarted) return;
  playStarted = true;
  // Fire-and-forget - we don't care about the resolved value here, only
  // about populating webpack's chunk cache. Errors are swallowed because
  // a failed prefetch is a non-event: the user clicking Play later will
  // re-trigger the import via the normal `dynamic()` path and surface
  // any real failure (network down, etc.) inside the route's own loader.
  void import("@/components/Game").catch(() => {
    playStarted = false;
  });
}

/**
 * Kick off the `/multi` route's heavy chunk (`components/multi/
 * MultiEntryClient.tsx` plus `socket.io-client` and the protocol
 * helpers). Same idempotency + chunk-unification rules as
 * `prefetchPlayChunk`.
 */
export function prefetchMultiChunk(): void {
  if (multiStarted) return;
  multiStarted = true;
  void import("@/components/multi/MultiEntryClient").catch(() => {
    multiStarted = false;
  });
}

/**
 * Schedule both chunk prefetches for the next idle period after page
 * load. Safe to call from a homepage `useEffect` - the actual `import()`
 * calls happen in an idle callback so they never compete with React's
 * commit phase, hydration, or the first frame of any animation already
 * starting up.
 *
 * Returns a cleanup function that cancels the pending idle callback if
 * the homepage unmounts before it fires. The chunks themselves can't
 * be "un-prefetched" once they're in flight, but cancelling the idle
 * callback at least avoids queueing extra work for a user who's
 * already clicked through to the destination.
 */
export function schedulePrefetchAll(): () => void {
  if (typeof window === "undefined") return () => {};

  // Use the typed global for `requestIdleCallback` - TS lib doesn't
  // include it everywhere, but we feature-detect at runtime so the
  // Safari fallback handles both "not present" and "present but
  // returning a different shape". The 2000 ms timeout ensures the
  // callback runs even on a perpetually-busy main thread, just at
  // a lower priority than freshly-painted content.
  const w = window as Window & {
    requestIdleCallback?: (
      cb: () => void,
      opts?: { timeout?: number },
    ) => number;
    cancelIdleCallback?: (id: number) => void;
  };

  let idleHandle: number | null = null;
  let timeoutHandle: number | null = null;

  const run = () => {
    prefetchPlayChunk();
    prefetchMultiChunk();
  };

  if (typeof w.requestIdleCallback === "function") {
    idleHandle = w.requestIdleCallback(run, { timeout: 2000 });
  } else {
    // Safari fallback. 600 ms is long enough for first-paint /
    // hydration to settle on a typical desktop without delaying the
    // prefetch so much that fast clickers beat it.
    timeoutHandle = window.setTimeout(run, 600);
  }

  return () => {
    if (idleHandle !== null && typeof w.cancelIdleCallback === "function") {
      w.cancelIdleCallback(idleHandle);
    }
    if (timeoutHandle !== null) {
      window.clearTimeout(timeoutHandle);
    }
  };
}

/**
 * Prebuilt event-handler bag for elements that navigate to a heavy
 * route. Spread onto a `<Link>` or `<button>` to wire pointer / focus
 * intent into the matching chunk warm-up:
 *
 *     <Link href="/play" {...prefetchOnIntent("play")}>...</Link>
 *
 * `pointerenter` covers mouse + pen + touch (touch fires it once on
 * tap-down, which is still ahead of the synthetic `click` that follows
 * tap-up - so even tap-then-release gets a head start on the chunk).
 * `focus` covers keyboard navigation. Both are passive observers - we
 * never call `preventDefault` or `stopPropagation`, so the underlying
 * Link's normal navigation behavior is untouched.
 */
export function prefetchOnIntent(target: "play" | "multi"): {
  onPointerEnter: () => void;
  onFocus: () => void;
} {
  const fn = target === "play" ? prefetchPlayChunk : prefetchMultiChunk;
  return {
    onPointerEnter: fn,
    onFocus: fn,
  };
}
