import Link from "next/link";

/**
 * Square 38×38 multiplayer entry button. Sized to match `ThemeToggle`
 * and `HomeButton` so the homepage header reads as a clean strip of
 * uniform icon controls instead of mixing button heights.
 *
 * Glyph: a 2×2 grid of solid squares — the same "swarm of pixels"
 * motif we use elsewhere as `░` to flag multiplayer copy ("░ Up to
 * 50 per room"). Brutalist, geometric, scales cleanly at this size,
 * and visually distinct from both the SYNCLE play-triangle logo and
 * the home glyph.
 */
export function MultiButton({ className = "" }: { className?: string }) {
  return (
    <Link
      href="/multi"
      className={`icon-btn ${className}`}
      aria-label="Multiplayer · up to 50 players per room"
      data-tooltip="Multiplayer · up to 50 players per room"
    >
      <MultiIcon />
    </Link>
  );
}

/**
 * 2×2 grid of solid 8-unit squares, separated by a 4-unit gutter,
 * centered in the 24×24 viewport. Filled (not stroked) so the icon
 * reads as four distinct "players" at this small size — an outlined
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
