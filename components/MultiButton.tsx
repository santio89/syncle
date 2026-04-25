import Link from "next/link";

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
      className={`inline-flex h-[38px] items-center gap-2 border-2 border-bone-50/60 px-3 leading-none text-bone-50 transition-colors hover:border-accent hover:text-accent active:translate-y-[1px] ${className}`}
      // aria-label kept explicit for screen readers (the visible
      // text is a single word so the label IS the destination, but
      // an explicit aria-label is cheap insurance against any AT
      // that reads only the icon).
      aria-label="Multiplayer rooms"
      // Tooltip becomes a value-add line ("what does this do?")
      // instead of just echoing the visible label. Short enough to
      // not feel verbose; matches the brut-tooltip line-length of
      // the rest of the header chips.
      data-tooltip="Play live with friends · up to 50 per room"
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
 * 2×2 grid of solid 8-unit squares, separated by a 4-unit gutter,
 * centered in the 24×24 viewport. Filled (not stroked) so the icon
 * reads as four distinct "players" at this small size - an outlined
 * version got muddy below 20px. Exported so footer / inline copy
 * can use the same glyph as `MultiButton` instead of the loose `░`
 * unicode character (which doesn't match weight at small sizes).
 */
export function MultiIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      <rect x="4"  y="4"  width="7" height="7" />
      <rect x="13" y="4"  width="7" height="7" />
      <rect x="4"  y="13" width="7" height="7" />
      <rect x="13" y="13" width="7" height="7" />
    </svg>
  );
}
