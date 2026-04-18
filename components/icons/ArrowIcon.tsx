// Brutalist arrow glyph rendered as a single SVG path. Square line caps,
// miter joins, no curves — matches the chunky geometric look of the rest of
// the UI. Color is inherited via `currentColor` so it adapts to the theme
// or to whatever `color`/`text-…` class wraps it.

import type { SVGProps } from "react";

export type ArrowDirection = "left" | "right" | "up" | "down";

interface ArrowIconProps extends Omit<SVGProps<SVGSVGElement>, "direction"> {
  direction: ArrowDirection;
  /** Square viewport size in pixels. Defaults to 1em so the icon scales with surrounding text. */
  size?: number | string;
  /** Stroke thickness in viewBox units (the viewBox is 24×24). */
  strokeWidth?: number;
}

const PATHS: Record<ArrowDirection, string> = {
  // Long shaft + chevron tip. Geometry sits just inside the 24×24 box so
  // square caps don't get clipped at the edge.
  left:  "M22 12 H4 M11 5 L4 12 L11 19",
  right: "M2 12 H20 M13 5 L20 12 L13 19",
  up:    "M12 22 V4 M5 11 L12 4 L19 11",
  down:  "M12 2 V20 M5 13 L12 20 L19 13",
};

export function ArrowIcon({
  direction,
  size = "1em",
  strokeWidth = 2.5,
  ...rest
}: ArrowIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <path d={PATHS[direction]} />
    </svg>
  );
}
