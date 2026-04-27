import Link from "next/link";
import { prefetchOnIntent } from "@/lib/prefetch";

/**
 * Header multiplayer entry button - labeled pill that pairs the
 * `MultiIcon` glyph with an explicit "MULTIPLAYER" word.
 *
 * History: this used to be an icon-only 38×38 square (just the 2×2
 * grid of dots) so it would line up with `ThemeToggle` / `HomeButton`
 * as a uniform strip of icon chips. Two pieces of user feedback
 * killed that approach:
 *   1. Newcomers consistently failed to recognise the four-dot grid
 *      as "multiplayer" - they read it as a generic "menu" or
 *      "apps" icon and ignored it. Brand-recognition for an icon-
 *      only entry point only works once people know it; the homepage
 *      can't assume that.
 *   2. The hover tooltip ("Multiplayer") only fired on pointer
 *      devices, so mobile users never saw the disambiguation at all.
 *
 * Fix: keep the icon (still correct, still on-brand) but pair it
 * with the literal word so there's zero ambiguity on first sight on
 * any device. Height matches `.icon-btn` (38px) so the header strip
 * stays in vertical rhythm with `ThemeToggle`; horizontal width
 * grows to accommodate the label. The bordered-pill aesthetic +
 * hover/active behavior mirrors `.icon-btn` exactly (border + color
 * → accent, 1px sink on press) so the two controls still read as
 * one family even with different proportions. Inline Tailwind
 * (rather than `.icon-btn` + extra class) because that CSS rule
 * hard-codes `width: 38px`, which we're intentionally overriding
 * here.
 */
export function MultiButton({ className = "" }: { className?: string }) {
  return (
    <Link
      href="/multi"
      // 38px height matches .icon-btn / ThemeToggle so the header
      // strip stays aligned. Horizontal padding (px-3) + gap-2 give
      // the label and icon comfortable breathing room without making
      // the pill larger than necessary at narrow viewports. Active
      // translate matches .icon-btn's 1px tactile sink. `leading-none`
      // collapses the implicit half-leading on the text span so its
      // bounding box equals its font-size - without it, the default
      // line-height (~1.5) gives the text a taller-than-needed box
      // and the visible caps drift below the icon's geometric centre
      // even with `items-center`. Same trick the "Refresh list"
      // button in MultiEntryClient uses for the same reason.
      //
      // `transform-gpu` forces the Tailwind transform utility onto
      // `translate3d(…, 0)` instead of the default 2D `translate(…)`,
      // which promotes the pill into its own GPU compositor layer.
      // It is NOT the fix for the MultiIcon "split" artifact (see
      // `MultiIcon` below for the actual fix: dropping
      // `shapeRendering="crispEdges"`) - GPU compositing alone
      // doesn't help there because `transition-colors` invalidates
      // the layer's texture on every colour tick. Kept anyway as a
      // cheap defensive layer: it prevents the compositor from
      // promoting / demoting the pill mid-interaction, which
      // eliminates one class of paint-order jitter on top of the
      // AA fix.
      className={`inline-flex h-[38px] items-center gap-2 border-2 border-bone-50/60 px-3 leading-none text-bone-50 transition-colors transform-gpu hover:border-accent hover:text-accent active:translate-y-[1px] ${className}`}
      // aria-label kept explicit for screen readers (the visible
      // text is a single word so the label IS the destination, but
      // an explicit aria-label is cheap insurance against any AT
      // that reads only the icon).
      aria-label="Multiplayer rooms"
      // Tooltip is a short value-add line ("what does this do?")
      // rather than echoing the visible label. Deliberately skips
      // the old room-capacity tagline - the live `{count}/{max}`
      // counter in the room list is the right place for that
      // number, and padding the tooltip with it read as marketing
      // copy next to the rest of the app's terse chip tooltips.
      data-tooltip="Play live with friends"
      // Intent-prefetch the /multi chunk on hover / focus. Same
      // layered strategy as the homepage's PLAY CTA: the homepage
      // already idle-prefetches both heavy chunks, but this header
      // pill is reachable from `/play` and `/multi/[code]` too -
      // pages that have NOT idle-prefetched - so the hover handler
      // is the warm-up path for cross-route navigation. See
      // `lib/prefetch` for the full rationale.
      {...prefetchOnIntent("multi")}
    >
      <MultiIcon size={14} />
      {/* Tracking matches the wordmark + nav text in the same header
          (font-mono, uppercase, ~0.25em tracking) so the label reads
          as part of the same typographic system. Slightly smaller
          font (10.5px) than the body nav text because the surround-
          ing border gives it visual weight that compensates for the
          smaller cap-height. */}
      <span className="font-mono text-[10.5px] uppercase tracking-[0.25em]">
        Multiplayer
      </span>
    </Link>
  );
}

/**
 * 2×2 grid of solid 7-unit squares, separated by a 2-unit gutter,
 * centered in the 24×24 viewport. Filled (not stroked) so the icon
 * reads as four distinct "players" at this small size - an outlined
 * version got muddy below 20px. Exported so footer / inline copy
 * can use the same glyph as `MultiButton` instead of the loose `░`
 * unicode character (which doesn't match weight at small sizes).
 *
 * NO `shapeRendering="crispEdges"`. The earlier version had it - it
 * pairs nicely with the brutalist theme in theory - but at the
 * default render size (14 px on a 24-unit viewBox → 1 viewBox unit
 * ≈ 0.58 CSS px), the 2-unit gutter between dots works out to
 * ~1.17 CSS px. That's deep in the sub-pixel danger zone: `crispEdges`
 * snaps each rect independently to the nearest device pixel, and the
 * gutter can round to 1 or 2 device px depending on the button's
 * current paint state. Any re-paint (hover transition mid-flight,
 * `active:translate-y-[1px]` sink, scroll composite) can re-snap the
 * two rows' gutters to different values, and the grid visibly
 * "splits" for the duration of that paint.
 *
 * Dropping the hint lets the browser anti-alias at the real
 * sub-pixel position - deterministic, paint-stable, and visually
 * imperceptible at 14 px (the AA halo is < 0.3 CSS px). The dots
 * stay crisp-looking because the fill is solid + integer-cornered;
 * the brutalist weight comes from the fill, not from snap-to-grid.
 * Same rationale would apply to any future `MultiIcon` use at small
 * sizes, so it's baked into the component rather than left as a
 * caller concern.
 */
export function MultiIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <rect x="4"  y="4"  width="7" height="7" />
      <rect x="13" y="4"  width="7" height="7" />
      <rect x="4"  y="13" width="7" height="7" />
      <rect x="13" y="13" width="7" height="7" />
    </svg>
  );
}
