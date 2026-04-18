"use client";

import { useTheme } from "./ThemeProvider";

/**
 * Sun/moon toggle. Both icons live stacked at the same center; CSS handles
 * the crossfade + rotate using --ease-theme so the two states are perfectly
 * in sync with the page-wide color transition triggered by the provider.
 *
 * The visible icon is whichever theme you'd switch TO — clicking on the sun
 * goes to dark, clicking on the moon goes to light. This is the convention
 * used by GitHub, Vercel, Linear, etc.
 */
export function ThemeToggle({ className = "" }: { className?: string }) {
  const { theme, toggle } = useTheme();
  const next = theme === "dark" ? "light" : "dark";

  return (
    <button
      type="button"
      onClick={toggle}
      className={`theme-toggle ${className}`}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
    >
      {/* Sun — visible when theme === light (i.e. clicking switches AWAY from sun → dark) */}
      <span className="theme-toggle__icon theme-toggle__icon--sun" aria-hidden="true">
        <SunIcon />
      </span>
      {/* Moon — visible when theme === dark */}
      <span className="theme-toggle__icon theme-toggle__icon--moon" aria-hidden="true">
        <MoonIcon />
      </span>
    </button>
  );
}

/* ---------------------------------------------------------------------------
 * Icons. Hand-drawn to match the brutalist square logo:
 *   - 2px stroke (matches header logo + card borders)
 *   - crispEdges shape rendering, square joins
 *   - radius / ray lengths tuned for visual weight parity with the moon
 * ------------------------------------------------------------------------- */

function SunIcon({ size = 18 }: { size?: number }) {
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
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      {/* Eight rays at 45° intervals — gives the icon a more even silhouette
       *  than the typical four-ray sun and reads better at 18px. */}
      <line x1="12" y1="2"  x2="12" y2="5" />
      <line x1="12" y1="19" x2="12" y2="22" />
      <line x1="2"  y1="12" x2="5"  y2="12" />
      <line x1="19" y1="12" x2="22" y2="12" />
      <line x1="4.5"  y1="4.5"  x2="6.6"  y2="6.6" />
      <line x1="17.4" y1="17.4" x2="19.5" y2="19.5" />
      <line x1="4.5"  y1="19.5" x2="6.6"  y2="17.4" />
      <line x1="17.4" y1="6.6"  x2="19.5" y2="4.5" />
    </svg>
  );
}

function MoonIcon({ size = 18 }: { size?: number }) {
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
      aria-hidden="true"
    >
      {/* Crescent: a rounded D-shape carved by an offset arc. The cutout
       *  is implemented as the second arc of the same path so we get a
       *  single closed shape (cleaner than masking). */}
      <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />
    </svg>
  );
}
