import Link from "next/link";

/**
 * Square 38×38 home icon used in headers across non-landing pages.
 * Lives next to ThemeToggle so the right side of every header reads
 * as a tidy strip of consistent icon controls.
 *
 * The visual language matches the SYNCLE logo and ThemeToggle icons:
 * 2 px stroke, square line caps, miter joins, no curves except the
 * roof apex. `currentColor` so border + glyph share the same color
 * driven by `.icon-btn` hover state.
 *
 * Always navigates to `/`. For "go back to where I came from" we
 * use the existing back-arrow link in the header (keeps "back" and
 * "home" semantically distinct).
 */
export function HomeButton({
  className = "",
  onNavigate,
}: {
  className?: string;
  /**
   * Optional cleanup hook fired before navigation. The multiplayer
   * room uses this to leave the socket cleanly so the player doesn't
   * linger in the roster for other clients during the connection
   * grace window. Called synchronously on click; navigation still
   * proceeds via the normal Link behavior.
   */
  onNavigate?: () => void;
}) {
  return (
    <Link
      href="/"
      onClick={onNavigate}
      className={`icon-btn ${className}`}
      aria-label="Main menu"
      title="Main menu"
    >
      <HomeIcon />
    </Link>
  );
}

function HomeIcon({ size = 19 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="square"
      strokeLinejoin="miter"
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      {/* Roof: pitched apex centered on the box, eaves tucked
          slightly inboard so the 2 px stroke doesn't clip at the
          24×24 viewport edge. */}
      <path d="M3 11 L12 3 L21 11" />
      {/* Body: square base anchored to the foot of the roof. */}
      <path d="M5 10 V21 H19 V10" />
      {/* Door: small rectangle centered in the lower half. Solid
          stroke (no fill) so the icon stays readable on both light
          and dark themes — currentColor + transparent fill follows
          the brutalist hollow-shape convention used elsewhere. */}
      <rect x="10" y="14" width="4" height="7" />
    </svg>
  );
}
