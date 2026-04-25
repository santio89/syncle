import type { Config } from "tailwindcss";

/**
 * All themed colors are CSS-var driven so the same Tailwind class
 * (e.g. `text-bone-50/70`) automatically swaps when [data-theme] flips.
 *
 * The `<alpha-value>` token is Tailwind's substitution for the alpha
 * modifier - `text-bone-50/70` becomes `rgb(var(--fg) / 0.7)`.
 *
 * Class-name semantics (kept stable so we didn't have to touch every JSX):
 *   bone-50  → primary foreground (text + borders on the page background)
 *   bone-100 → softer foreground variant
 *   ink-900  → page background
 *   ink-800  → slightly elevated surface
 *   ink-700  → top of the elevation stack
 *   accent   → brand blue (light mode shifts to a deeper blue for contrast)
 */
const cssVar = (name: string) => `rgb(var(${name}) / <alpha-value>)`;

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        ink: {
          900: cssVar("--bg"),
          800: cssVar("--bg-2"),
          700: cssVar("--bg-3"),
          // Static neutrals (legacy shades, not theme-swapped - only used
          // in a couple of isolated places that benefit from a fixed tone).
          600: "#181c25",
          500: "#252a36",
          400: "#3a4150",
          300: "#5a6272",
        },
        bone: {
          50: cssVar("--fg"),
          100: cssVar("--fg-2"),
          200: "#d8d4c4",
        },
        accent: {
          DEFAULT: cssVar("--accent"),
          400: cssVar("--accent"),
          500: cssVar("--accent"),
          600: cssVar("--accent"),
          700: cssVar("--accent"),
          glow: cssVar("--accent"),
        },
      },
      fontFamily: {
        display: ["var(--font-display)", "ui-sans-serif", "system-ui"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      boxShadow: {
        brut: "6px 6px 0 0 rgb(var(--shadow))",
        "brut-sm": "3px 3px 0 0 rgb(var(--shadow))",
        "brut-accent": "6px 6px 0 0 rgb(var(--accent) / 0.6)",
      },
      transitionTimingFunction: {
        theme: "cubic-bezier(0.65, 0, 0.35, 1)",
      },
      transitionDuration: {
        theme: "380ms",
      },
    },
  },
  plugins: [],
};

export default config;
