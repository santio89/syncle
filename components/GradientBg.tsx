"use client";

import { useEffect, useRef, type RefObject } from "react";

/**
 * Soft animated gradient blobs that drift in a tight cluster around the
 * CENTER of whatever element this is rendered into, blending so overlapping
 * blues mix into brighter cyan/teal/violet highlights - the "Stripe website"
 * liquid-gradient look.
 *
 * Positioning is intentionally DOM-driven, not canvas-driven:
 *   - All blob coordinates (cx, cy) are expressed as fractions of the
 *     canvas's own width/height, with the cluster centered around
 *     (0.5, 0.6) - slightly bottom-biased.
 *   - Where the cluster appears on the page is therefore fully
 *     determined by where the parent positions the canvas. To anchor
 *     the halo to a specific element (e.g. the play CTA on the
 *     homepage), wrap that element in a `relative` container and
 *     drop `<GradientBg />` inside an absolutely-positioned sibling
 *     with a generous negative inset (`-inset-[28rem]` etc). The
 *     gradient cluster will then bloom around that element without
 *     any per-viewport hand-tuning of cx/cy.
 *
 * Two key tricks make it feel artistic instead of generic:
 *
 *   1. Additive-ish compositing (`globalCompositeOperation = "screen"`)
 *      - when two blobs overlap, their RGB values combine via the
 *      screen formula (1 - (1-a)(1-b)), so deep navy + cyan brightens
 *      to teal and brand-blue + indigo nudges toward violet, but the
 *      mix asymptotes to white instead of clipping there. Stops
 *      "lighter" from punching out a harsh white center.
 *
 *   2. Lissajous motion - each blob has independent X and Y frequencies
 *      (and independent phases), so it traces an ellipse / figure-8
 *      instead of a circle. Across 9 blobs with different ratios the
 *      cluster's overlap pattern keeps morphing indefinitely without
 *      ever looking like a periodic loop.
 */
type Blob = {
  /** Anchor as a fraction of canvas size (0..1). */
  cx: number;
  cy: number;
  /** Sine amplitude as a fraction of canvas size, X / Y axes independent. */
  ax: number;
  ay: number;
  /** Oscillation frequency in radians/sec, X / Y axes independent. */
  freqX: number;
  freqY: number;
  /** Phases in radians, X / Y axes independent - drives Lissajous orbit. */
  phaseX: number;
  phaseY: number;
  /** Radius as a fraction of max(width, height). */
  r: number;
  /**
   * Either an explicit "r,g,b" string or a CSS-var name (without `var()`).
   * Var names are resolved against `document.documentElement` each frame so
   * the gradient retints when the theme changes - no remount required.
   */
  hue: string | { var: string };
  /** Base opacity at the blob's brightest peak. */
  alpha: number;
  /**
   * Alpha "breathing" - multiplies the rendered alpha by
   * `1 + sin(t*breathFreq + breathPhase) * breathDepth` so each blob
   * fades in and out independently. With different freqs across the
   * cluster, the visible color mix keeps shifting (one moment indigo
   * dominates, the next cyan does) without any blob ever fully
   * disappearing. Set `breathDepth` to 0 for a static blob.
   */
  breathDepth: number;
  breathFreq: number;
  breathPhase: number;
};

// Brand-aligned palette anchored around the CENTER of the canvas.
// The canvas itself is positioned by the parent (e.g. an absolute
// wrapper around the play CTA on the homepage), so all blob coords
// are relative to that local box rather than the viewport.
//
// Cluster geometry: bulk centered at (0.5, 0.6) - slightly below
// the box center, so when the parent wraps the play CTA, the halo
// blooms mostly *below* the CTA (matching the user's "below and to
// the sides, not so much top, just a bit" direction) while a small
// bridge blob sits directly behind it.
//
// Three families of blobs, deliberately mixed:
//
//   1. ANCHORS (deep, low-breath) - deep blue, deep navy, deep indigo.
//      Provide the "rich" base color so the cluster reads as
//      saturated theme-blue instead of pastel wash.
//
//   2. CORE (mid, mid-breath) - brand accent, mid-blue, blue-violet.
//      Sit at the perceptual center of the cluster and do most of
//      the color-mixing work.
//
//   3. HIGHLIGHTS (bright, high-breath) - cyan + periwinkle. Small
//      blobs with strong breathing depth, so they sometimes surge
//      as flashes of bright over the dark anchors, then fade.
//
// Anchors stay roughly steady; highlights pulse hard. Different
// breath frequencies (0.10 – 0.22 Hz) and phases keep the cluster
// from ever syncing into a single beat. Screen blend mode means
// deep colors stay deep on their own and only brighten where
// bright + bright overlap - preserving contrast through the cycle.
//
// Radii are noticeably larger than the previous viewport-wide
// version (0.18 – 0.28 vs 0.10 – 0.17) because the canvas is now
// the size of the halo zone (~30rem wide), not the full viewport.
// Same fractional radius == smaller pixel halo, so we scale up to
// keep the perceived softness/spread.
const BLOBS: Blob[] = [
  // CORE - brand accent, dead center of the cluster. Identity color.
  {
    cx: 0.50, cy: 0.60,
    ax: 0.045, ay: 0.040,
    freqX: 0.30, freqY: 0.22,
    phaseX: 0.0, phaseY: 1.1,
    r: 0.20,
    hue: { var: "--accent" },
    alpha: 0.55,
    breathDepth: 0.28, breathFreq: 0.16, breathPhase: 0.0,
  },
  // ANCHOR - deep saturated blue, lower-left of the cluster.
  // Largest blob, low breath: the "ground tone" everything mixes over.
  {
    cx: 0.43, cy: 0.72,
    ax: 0.035, ay: 0.040,
    freqX: 0.18, freqY: 0.13,
    phaseX: 1.2, phaseY: 0.5,
    r: 0.26,
    hue: "20, 80, 200",
    alpha: 0.66,
    breathDepth: 0.16, breathFreq: 0.12, breathPhase: 1.7,
  },
  // ANCHOR - deep indigo, lower-right. Pairs with the deep blue
  // anchor to weight the bottom of the cluster with rich indigo.
  {
    cx: 0.60, cy: 0.70,
    ax: 0.040, ay: 0.045,
    freqX: 0.20, freqY: 0.16,
    phaseX: 3.6, phaseY: 2.2,
    r: 0.22,
    hue: "55, 50, 195",
    alpha: 0.62,
    breathDepth: 0.20, breathFreq: 0.14, breathPhase: 2.5,
  },
  // CORE - mid blue, left of the cluster center. Slightly cooler
  // than the brand accent so overlap mixes to a richer blue.
  {
    cx: 0.40, cy: 0.60,
    ax: 0.055, ay: 0.040,
    freqX: 0.34, freqY: 0.24,
    phaseX: 2.4, phaseY: 3.0,
    r: 0.20,
    hue: "45, 130, 235",
    alpha: 0.50,
    breathDepth: 0.26, breathFreq: 0.18, breathPhase: 2.6,
  },
  // CORE - blue-violet right of cluster center. Purple-leaning
  // blue: overlap with the accent visibly biases toward violet
  // without leaving the blue family.
  {
    cx: 0.60, cy: 0.58,
    ax: 0.045, ay: 0.040,
    freqX: 0.32, freqY: 0.26,
    phaseX: 1.3, phaseY: 0.4,
    r: 0.18,
    hue: "100, 90, 235",
    alpha: 0.48,
    breathDepth: 0.30, breathFreq: 0.17, breathPhase: 1.4,
  },
  // ANCHOR - deepest navy, anchors the very bottom of the cluster.
  // Darkest blob in the field; steady breath = perceptual "floor."
  {
    cx: 0.50, cy: 0.85,
    ax: 0.030, ay: 0.030,
    freqX: 0.16, freqY: 0.12,
    phaseX: 0.8, phaseY: 3.0,
    r: 0.20,
    hue: "10, 40, 150",
    alpha: 0.68,
    breathDepth: 0.14, breathFreq: 0.10, breathPhase: 3.2,
  },
  // HIGHLIGHT - bright cyan, upper-left. Big breath depth so it
  // crests as a flash of bright over the dark anchors below, then
  // fades - a major source of the "bright moments" in the cycle.
  {
    cx: 0.40, cy: 0.55,
    ax: 0.050, ay: 0.030,
    freqX: 0.36, freqY: 0.28,
    phaseX: 2.0, phaseY: 0.4,
    r: 0.15,
    hue: "120, 220, 255",
    alpha: 0.42,
    breathDepth: 0.45, breathFreq: 0.20, breathPhase: 1.2,
  },
  // HIGHLIGHT - periwinkle (light blue-violet) at the upper-right.
  // Pulses strongly; when it surges with the cyan above, the cluster
  // briefly washes lavender-cyan.
  {
    cx: 0.60, cy: 0.52,
    ax: 0.045, ay: 0.030,
    freqX: 0.30, freqY: 0.34,
    phaseX: 0.6, phaseY: 1.6,
    r: 0.15,
    hue: "150, 160, 250",
    alpha: 0.40,
    breathDepth: 0.42, breathFreq: 0.19, breathPhase: 2.4,
  },
  // BRIDGE HINT - small dim periwinkle directly behind/above the
  // anchor element. Bridges the gap so the anchor element still
  // feels visually connected to the gradient instead of floating
  // on bare bg, even though the bulk has moved south.
  {
    cx: 0.50, cy: 0.45,
    ax: 0.025, ay: 0.020,
    freqX: 0.28, freqY: 0.34,
    phaseX: 1.9, phaseY: 0.5,
    r: 0.13,
    hue: "120, 160, 255",
    alpha: 0.30,
    breathDepth: 0.40, breathFreq: 0.22, breathPhase: 0.8,
  },
];

/**
 * Read an `--xxx` CSS variable from `<html>` and return its space-separated
 * RGB triplet rewritten with commas so it can be used inside `rgba(...)`.
 * Returns null if the var isn't defined (e.g. SSR / pre-hydration).
 */
function readRgbVar(name: string): string | null {
  if (typeof window === "undefined") return null;
  const raw = window
    .getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  if (!raw) return null;
  return raw.replace(/\s+/g, ", ");
}

type Props = {
  /**
   * If provided, the cluster of blobs is positioned so its perceptual
   * center sits on the center of this element. Tracked via
   * ResizeObserver + scroll/resize listeners, so it stays glued to
   * the anchor through layout reflows.
   *
   * If omitted, the cluster is centered in the canvas (the original
   * full-area wash behavior used by the multi pages).
   */
  anchorRef?: RefObject<HTMLElement | null>;
  /**
   * Cluster spread in pixels - the side length of the "logical" box
   * the blob fractional coordinates (cx/cy/r) are scaled against.
   * Bigger = wider, lower-density halo. Default 1100 ≈ the visible
   * halo size from the previous fixed-canvas iteration.
   */
  clusterSize?: number;
};

export function GradientBg({
  anchorRef,
  clusterSize = 1100,
}: Props = {}) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrapper = wrapperRef.current;
    if (!canvas || !wrapper) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let width = 0;
    let height = 0;
    let dpr = Math.min(window.devicePixelRatio || 1, 2);

    // Anchor center in canvas-local pixel coordinates. Recomputed
    // whenever the anchor or wrapper changes size/position.
    let anchorCx = 0;
    let anchorCy = 0;

    const resize = () => {
      // Canvas always fills its parent - never has its own fixed size.
      // This is the whole point of the new approach: the canvas can't
      // be edge-clipped by ancestors because it's only ever as big as
      // its container, and the cluster lives at JS-tracked pixel
      // coordinates inside it instead of being baked into canvas-
      // relative fractions.
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    /**
     * Recompute the anchor's center in canvas-local pixels.
     * - With anchorRef: measure both the anchor and the wrapper in
     *   viewport coordinates, subtract, and you get wrapper-relative
     *   pixels regardless of scroll, layout offsets, etc.
     * - Without anchorRef: centered in the canvas (legacy wash mode).
     */
    const updateAnchorCenter = () => {
      if (!anchorRef?.current) {
        anchorCx = width / 2;
        anchorCy = height / 2;
        return;
      }
      const a = anchorRef.current.getBoundingClientRect();
      const w = wrapper.getBoundingClientRect();
      anchorCx = a.left + a.width / 2 - w.left;
      anchorCy = a.top + a.height / 2 - w.top;
    };

    const updateAll = () => {
      resize();
      updateAnchorCenter();
    };

    updateAll();

    // ResizeObserver picks up the anchor changing size (responsive
    // breakpoints, font-size changes) AND the wrapper changing size
    // (page layout reflow). Window resize covers viewport changes
    // that don't trigger an RO event, and scroll covers in-page
    // panning when content exceeds 100dvh.
    const ro = new ResizeObserver(updateAll);
    if (anchorRef?.current) ro.observe(anchorRef.current);
    ro.observe(wrapper);

    window.addEventListener("resize", updateAll);
    const onScroll = () => updateAnchorCenter();
    window.addEventListener("scroll", onScroll, {
      passive: true,
      capture: true,
    });

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const t0 = performance.now();

    // 60fps target so the cluster actually reads as smoothly animated on
    // high-refresh monitors. The drawing loop is cheap (8 radial gradient
    // fills + a single CSS blur on the canvas element, GPU-accelerated)
    // so the cost is negligible vs the visual upgrade - at 30fps the
    // breathing/drift looked stuttery on 120/144/200Hz displays.
    const TARGET_FPS = reduce ? 1 : 60;
    const FRAME_MS = 1000 / TARGET_FPS;
    let lastDraw = 0;

    /**
     * Cache resolved CSS-var hues across draws - getComputedStyle isn't
     * cheap, and the value only changes when the theme flips. We refresh
     * the cache once per second; that's plenty given the toggle's ~400ms
     * transition and the gradient's heavy 48px CSS blur smoothing it out.
     */
    const hueCache = new Map<string, string>();
    let lastHueRefresh = 0;
    const HUE_REFRESH_MS = 1000;

    const resolveHue = (h: Blob["hue"], now: number): string => {
      if (typeof h === "string") return h;
      if (now - lastHueRefresh > HUE_REFRESH_MS) {
        hueCache.clear();
        lastHueRefresh = now;
      }
      let v = hueCache.get(h.var);
      if (!v) {
        v = readRgbVar(h.var) ?? "61, 169, 255"; // accent fallback
        hueCache.set(h.var, v);
      }
      return v;
    };

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - lastDraw < FRAME_MS) return;
      lastDraw = now;

      const t = (now - t0) / 1000; // seconds
      ctx.clearRect(0, 0, width, height);

      // `screen` blending: result = 1 - (1 - dst) * (1 - src). Like
      // additive (`lighter`) it brightens overlaps, but the curve
      // softly approaches white instead of clipping to it - which
      // kills the "harsh white center where the cluster overlaps"
      // problem that `lighter` had at our current alphas. The mix
      // colors stay vivid (cyan + indigo still goes lavender, accent
      // + cyan still goes electric teal) but the bright spot in the
      // middle is gentle instead of a punched-out highlight.
      const prevComposite = ctx.globalCompositeOperation;
      ctx.globalCompositeOperation = "screen";

      for (const b of BLOBS) {
        // Lissajous orbit: independent X and Y frequencies → ellipses /
        // figure-8s instead of perfect circles, so the cluster's overlap
        // pattern keeps morphing instead of looping every 2π/freq.
        // Amplitudes (b.ax/b.ay) are fractions of clusterSize, so the
        // motion scales with how big a halo we want.
        const offX = reduce ? 0 : Math.sin(t * b.freqX + b.phaseX) * b.ax;
        const offY = reduce ? 0 : Math.cos(t * b.freqY + b.phaseY) * b.ay;
        // Position relative to anchor center: (b.cx - 0.5) re-centers
        // the blob's logical coordinates around 0 (so b.cx=0.5,
        // b.cy=0.5 places the blob exactly on the anchor) and
        // multiplying by clusterSize converts to pixels. This is the
        // key change vs the old fractional-canvas model - the blobs
        // know where the play CTA is, not where the canvas edge is.
        const cx = anchorCx + (b.cx - 0.5 + offX) * clusterSize;
        const cy = anchorCy + (b.cy - 0.5 + offY) * clusterSize;
        const radius = b.r * clusterSize;
        const hue = resolveHue(b.hue, now);

        // "Breathing" alpha - slow per-blob sine that fades each blob
        // in and out around its base alpha. Different breath frequencies
        // across the cluster (~0.13 – 0.22 Hz) mean no two blobs peak
        // together, so the dominant color of the field is always
        // shifting (cyan moment → indigo moment → teal moment …)
        // even though the positions are fairly stable. Reduced-motion
        // disables the modulation along with the orbits.
        const breath = reduce
          ? 1
          : 1 + Math.sin(t * b.breathFreq + b.breathPhase) * b.breathDepth;
        const a = Math.max(0, b.alpha * breath);

        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
        grad.addColorStop(0, `rgba(${hue}, ${a})`);
        // Mid-stop falls off softer than a pure linear ramp - gives the
        // blobs a gauzy core-to-edge transition that reads as "liquid"
        // once the CSS blur compounds it.
        grad.addColorStop(0.55, `rgba(${hue}, ${a * 0.35})`);
        grad.addColorStop(1, `rgba(${hue}, 0)`);
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, width, height);
      }

      ctx.globalCompositeOperation = prevComposite;
    };

    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", updateAll);
      window.removeEventListener("scroll", onScroll, { capture: true });
    };
  }, [anchorRef, clusterSize]);

  return (
    <div
      ref={wrapperRef}
      aria-hidden
      // `absolute inset-0 overflow-hidden`: covers the parent's
      // content area (e.g. <main>) and clips anything that tries to
      // paint past it. The canvas inside fills this wrapper exactly,
      // so it can never be edge-clipped - and the cluster lives at
      // anchor-relative pixel coordinates inside the canvas, fading
      // to transparent via the radial-gradient blob alpha falloff
      // (no CSS mask required).
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      <canvas
        ref={canvasRef}
        className="h-full w-full"
        // `filter: blur(40px)` - gauzy bloom so the underlying
        // radial-gradient disc shapes read as one liquid mass instead
        // of overlapping circles. 40px is the sweet spot for current
        // radii (~0.18 – 0.26 of clusterSize); bigger smears the
        // saturated cores into a flat wash, smaller lets the discs
        // show.
        style={{ filter: "blur(40px)" }}
      />
    </div>
  );
}
