// Brutalist arrow glyph rendered as a single SVG path. Square line caps,
// miter joins, no curves - matches the chunky geometric look of the rest of
// the UI. Color is inherited via `currentColor` so it adapts to the theme
// or to whatever `color`/`text-…` class wraps it.

import type { SVGProps } from "react";

export type ArrowDirection =
  | "left"
  | "right"
  | "up"
  | "down"
  | "up-right"
  | "up-left"
  | "down-right"
  | "down-left";

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
  // Diagonals: 45° shaft from one corner to the opposite, with a right-
  // angle chevron at the tip whose arms run back along the two cardinal
  // axes that meet there. Same 7-unit chevron arm length as the
  // cardinal arrows so the diagonals read as part of the same family
  // when mixed in a row of icons.
  "up-right":   "M4 20 L19 5 M12 5 L19 5 L19 12",
  "up-left":    "M20 20 L5 5 M12 5 L5 5 L5 12",
  "down-right": "M4 4 L19 19 M12 19 L19 19 L19 12",
  "down-left":  "M20 4 L5 19 M12 19 L5 19 L5 12",
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
