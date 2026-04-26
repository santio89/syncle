import { GameState, JudgmentEvent, isHold } from "./engine";
import {
  Judgment,
  LANE_COLORS,
  LANE_LABEL,
  MAIN_LANE_COUNT,
  Note,
  TOTAL_LANES,
} from "./types";

// Arrow direction painted under each lane letter. Mirrors LANE_ALT_LABEL
// in `types.ts` (0=←, 1=↓, 2=↑, 3=→) but as a structured enum so we can
// draw the arrow as canvas paths instead of relying on a font glyph.
type ArrowDir = "left" | "right" | "up" | "down";
const LANE_ARROW_DIR: Record<number, ArrowDir> = {
  0: "left",
  1: "down",
  2: "up",
  3: "right",
};

export type ThemeName = "dark" | "light";

/**
 * Visual quality preset.
 *
 * - `"high"`        → all VFX (particles, shockwaves, glow halos,
 *                     milestone vignette, lane-gate anticipation,
 *                     tap-note + hold-trail glow). Default.
 * - `"performance"` → prunes the heaviest fillrate-bound effects so
 *                     the highway stays smooth on integrated GPUs and
 *                     on low-end mobile, AND so accessibility-minded
 *                     players who don't want pulsing flashes can keep
 *                     gameplay calm. Notes/holds/judgment line/beat
 *                     dot still draw - gameplay reads identical, just
 *                     without celebratory polish.
 *
 * Mirrors `RenderQuality` from `lib/game/settings` (kept here as a
 * type alias so `renderer.ts` doesn't pull in the storage layer).
 */
export type RenderQualityMode = "high" | "performance";

/**
 * Playfield perspective mode. Mirrors `PerspectiveMode` from
 * `lib/game/settings` (kept here as a type alias so `renderer.ts`
 * doesn't pull in the storage layer).
 *
 * - `"3d"` → Guitar Hero / Rock Band trapezoid highway. Top edge
 *            at 50% of the bottom width, rails converge toward
 *            the top, notes + hold trails scale from small-at-top
 *            to large-at-judgment-line, beat lines taper to match.
 *            The shipping default.
 *
 * - `"2d"` → osu!mania-style flat layout. `ensureCache` collapses
 *            `topHalf` to `bottomHalf` so every cached endpoint
 *            (rails, lane separators, per-lane top/bottom X) sits
 *            at the same X from top to bottom. `drawTapNote` +
 *            `drawHoldTrail` pin radius / width to the
 *            PERSPECTIVE_* constants so notes don't scale with
 *            progress. Eliminates the 3D-highway-vs-2D-buttons
 *            mismatch that some players find disorienting.
 *
 * Gameplay math is identical in both modes - the playfield's
 * VERTICAL extent (topY, judgeY, leadTime mapping) is unchanged,
 * so note timing, hit windows, scoring, and replay events are
 * bit-identical. Toggling mid-match takes effect on the next
 * ensureCache invalidation (resize / theme swap / next phase
 * boundary); the per-frame draw paths just read `opts.perspectiveMode`.
 */
export type PerspectiveRenderMode = "2d" | "3d";
/**
 * Note + receptor shape. Purely cosmetic - gameplay math (timing
 * windows, hit registration, scoring) is identical across shapes.
 * `"rect"` matches the brutalist theme of the rest of the app;
 * `"circle"` is the classic rhythm-game disc look.
 */
export type NoteShapeMode = "rect" | "circle";

export interface RenderOptions {
  /** Seconds of look-ahead - note travels from top to judgment line in this time. */
  leadTime: number;
  /** Pulses each lane gate when its key is held. Indexed by lane (0 .. TOTAL_LANES-1). */
  laneHeld: boolean[];
  /** Judgment line vertical position as fraction of canvas height (0..1). */
  judgeLineY: number;
  /** BPM of the current song (for beat-line drawing & beat pulse). */
  bpm: number;
  /** Song offset (seconds) for beat-line alignment. */
  offset: number;
  /** Active UI theme - drives the canvas color palette. */
  theme: ThemeName;
  /**
   * Visual quality preset (`"high"` or `"performance"`). The hot
   * draw paths short-circuit the heaviest VFX in `"performance"`
   * mode without re-allocating any state, so toggling at runtime
   * takes effect on the next frame.
   */
  quality: RenderQualityMode;
  /**
   * Playfield perspective (`"3d"` = Guitar-Hero-style trapezoid,
   * `"2d"` = osu!-style flat rectangle). See `PerspectiveRenderMode`
   * above. Changing this requires a cache rebuild because the
   * trapezoid corners / rail slopes / per-lane endpoints are baked
   * in `ensureCache`; the rebuild is triggered by storing the
   * active mode on the cache and invalidating when it changes.
   */
  perspectiveMode: PerspectiveRenderMode;
  /**
   * Tap-note + lane-receptor shape (`"rect"` = brutalist
   * rectangles / trapezoids, `"circle"` = classic rhythm-game
   * discs). Purely a draw-path branch in `drawTapNote` and
   * `drawLaneGate` - doesn't invalidate the geometry cache, which
   * is shape-agnostic (the cache holds lane endpoints + widths,
   * not tile silhouettes). Toggle at runtime takes effect on the
   * next frame.
   */
  noteShape: NoteShapeMode;
}

/**
 * All canvas colors that change with the active theme. Resolved once per
 * frame from `opts.theme` and threaded into every draw helper. Anything
 * NOT in here (lane colors, judgment popup grades) is intentionally
 * theme-agnostic - those use a fixed brand palette so a perfect-tap
 * always reads as "blue green great" regardless of UI mode.
 */
export interface ThemePalette {
  /** Stable id used to invalidate the gradient cache on theme swap. */
  id: ThemeName;
  /**
   * Reference page-bg color matching the app's `--bg` CSS token.
   *
   * NOTE: `drawFrame` does NOT paint this - it `clearRect`s the canvas
   * and lets the underlying body background (which is themed via CSS
   * with a 220ms cubic-bezier crossfade) show through. The field is
   * kept on the palette for two reasons:
   *   1. It documents which RGB the canvas SHOULD line up with, so a
   *      reader doesn't have to cross-reference globals.css.
   *   2. Any future blending math (alpha compositing tests, stat
   *      visualizations rendered onto the highway, etc.) that needs
   *      to know the "true" body color has it locally available.
   */
  pageBg: string;
  /** Outer color stop of the radial vignette (inner stop is always transparent). */
  vignetteOuter: string;
  /** Three vertical gradient stops of the highway floor (top → mid → bottom). */
  highwayStops: [string, string, string];
  /** 1px verticals between lanes. */
  laneSeparator: string;
  /** Horizontal beat lines (off-beat). */
  beatLine: string;
  /** Horizontal measure lines (every 4th beat - slightly stronger). */
  measureLine: string;
  /** Base RGB for the judgment line (alpha is computed per-frame from the beat pulse). */
  judgeRgb: RGB;
  /** Base alpha at rest for the judgment line. Pulse adds on top. */
  judgeBaseAlpha: number;
  /** Brand accent (rails, judgment-line glow, perfect-tap halo). Theme-shifted for contrast. */
  accentRgb: RGB;
  /** Fill inside a tap-note ring. Same tone as the page bg so the colored ring reads. */
  noteInner: string;
  /** Tiny center dot inside a tap note. Inverted vs noteInner for contrast. */
  noteCore: string;
  /** Inside of a lane gate (the dark/light "hole" inside the colored ring). */
  gateInner: string;
  /** Lane label color when the gate is being held / sustained - sits on a colored fill. */
  gateLabelOnFill: string;
  /** Beat dot in the top-right corner on non-downbeats. Downbeats use the accent. */
  beatDotIdle: string;
}

const DARK_PALETTE: ThemePalette = {
  id: "dark",
  pageBg: "#050608",
  vignetteOuter: "rgba(0,0,0,0.85)",
  highwayStops: ["#0a0c10", "#10131a", "#181c25"],
  laneSeparator: "rgba(255,255,255,0.06)",
  beatLine: "rgba(255,255,255,0.07)",
  measureLine: "rgba(255,255,255,0.22)",
  judgeRgb: { r: 245, g: 245, b: 240 },
  judgeBaseAlpha: 0.85,
  accentRgb: { r: 61, g: 169, b: 255 },
  noteInner: "#0a0c10",
  noteCore: "#f5f5f0",
  gateInner: "#0a0c10",
  gateLabelOnFill: "#0a0c10",
  beatDotIdle: "#f5f5f0",
};

const LIGHT_PALETTE: ThemePalette = {
  id: "light",
  // Tracks --bg in light mode (245 245 240). Slight warmth, not pure white,
  // matching the brutalist "bone" surface the rest of the app uses.
  pageBg: "#f5f5f0",
  // Light-mode vignette intentionally NEUTRALIZED (transparent fill).
  //
  // We used to paint rgba(20,18,14,0.18) at the outer ring for focus
  // pull, but on a cream `--bg` that blended down to ~rgb(204,204,199)
  // at the canvas corners - visibly grayer than the surrounding page
  // bg, so the gameplay rectangle read as a darker chunk floating
  // inside a brighter page. (In dark mode the same trick is invisible
  // because pageBg is already near-black; the darken-to-black just
  // deepens corners by a few values.)
  //
  // The depth cue is still carried by the light highway gradient
  // (white → cream → tan), which is brighter than the page, so the
  // highway naturally pops without any vignette help. Keeping the
  // gradient stop in `palette.vignetteOuter` (instead of skipping
  // the fill) means the per-frame draw path stays branch-free.
  vignetteOuter: "rgba(245,245,240,0)",
  // Highway gradient flips: brightest at the top (where notes spawn) fading
  // to a slightly tanned shadow near the judgment line. Keeps the depth cue
  // working ("notes come out of the light, land in the cooler foreground").
  highwayStops: ["#ffffff", "#ebe9e0", "#d8d4c4"],
  // Black-on-cream separators read better than white at low alpha.
  laneSeparator: "rgba(12,14,18,0.10)",
  beatLine: "rgba(12,14,18,0.12)",
  measureLine: "rgba(12,14,18,0.32)",
  judgeRgb: { r: 18, g: 20, b: 24 },
  judgeBaseAlpha: 0.85,
  // Matches --accent in light mode (deeper blue for cream-bg contrast).
  accentRgb: { r: 14, g: 108, b: 186 },
  // Light fill inside notes/gates so the colored ring + outer glow still
  // pop, just inverted relative to the dark theme.
  noteInner: "#f5f5f0",
  noteCore: "#0a0c10",
  gateInner: "#f5f5f0",
  // When a lane is being held, the gate fills with its lane color and the
  // label needs to ride on top - light text on saturated color reads well.
  gateLabelOnFill: "#f5f5f0",
  beatDotIdle: "#0c0e12",
};

const PALETTES: Record<ThemeName, ThemePalette> = {
  dark: DARK_PALETTE,
  light: LIGHT_PALETTE,
};

export function getPalette(theme: ThemeName): ThemePalette {
  return PALETTES[theme] ?? DARK_PALETTE;
}

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Remaining life in seconds. */
  life: number;
  /** Total life so we can compute alpha as life/maxLife. */
  maxLife: number;
  size: number;
  /** Index into LANE_RGB - avoids per-particle string storage and reparse. */
  laneIdx: number;
}

export interface PendingHit {
  lane: number;
  judgment: Judgment;
  /** True for the release-end of a hold. */
  tail?: boolean;
}

/** A single expanding shockwave from a perfect/great hit. */
export interface Shockwave {
  x: number;
  y: number;
  laneIdx: number;
  /** Seconds remaining. */
  life: number;
  maxLife: number;
  /** True for "perfect" - drawn slightly larger and with a white core. */
  intense: boolean;
}

/**
 * Combo milestone strobe - when the player passes 25/50/100/250/500/1000+,
 * we tint the rails + judge line briefly so the eye gets a *moment*. Decays
 * to zero over `MILESTONE_FLASH_DUR_MS`.
 */
export interface MilestoneFlash {
  /** 0..1 strength remaining. */
  strength: number;
  /** Combo value at trigger time (used by the HUD-side chime). */
  combo: number;
}

export interface RenderState {
  /**
   * Last few judgment events for floating popups.
   *
   * NOTE: this is intentionally aliased to the engine's own
   * `state.events` ring buffer (see `Game.tsx` / `MultiGame.tsx`). We
   * reference-share rather than slice every frame because the renderer
   * only READS this array (drawJudgmentPopups iterates with a `for`
   * loop and skips already-aged entries by `songTime - ev.at`). If you
   * ever need to mutate this array from the renderer side, copy first
   * - the engine reuses the same backing array across frames.
   */
  recentEvents: JudgmentEvent[];
  /** Lane flash impulses [0..1] driven by hits. Indexed by lane. */
  laneFlash: number[];
  /**
   * Per-lane "anticipation" pulse [0..1] - set by drawHighway whenever a
   * note is within ANTICIPATION_WINDOW_S of the judge line. Read by
   * drawLaneGate to widen the ring + brighten the glow so the player sees
   * the gate "loading" before the note arrives.
   */
  laneAnticipation: number[];
  /** Active particle pool. Capped to PARTICLE_BUDGET so we can't unbounded-grow. */
  particles: Particle[];
  /** Active shockwave pool - much smaller than particles (capped at 24). */
  shockwaves: Shockwave[];
  /** Hit events pushed by the game; renderer drains and converts to particles. */
  pendingHits: PendingHit[];
  /** Combo to display on the canvas. Set by Game.tsx every frame. */
  combo: number;
  /** Latest combo-milestone flash, or null. Decayed in-place. */
  milestone: MilestoneFlash | null;
  /**
   * Monotonic "leading edge" cursor into `state.notes`. Renderer's per-frame
   * note loops start scanning here instead of at index 0, skipping notes that
   * are far enough in the past to no longer contribute any pixels (their
   * past-grace fade plus judged fade have both elapsed). Cuts the per-frame
   * iteration count from O(songProgress · density) down to O(visibleWindow).
   *
   * Conservative advancement: only step forward when the current note's
   * latest relevant time (`endT` for holds, `t` for taps) is well outside
   * BOTH fade windows, so we never skip a note that could still draw a
   * trailing fade pixel.
   */
  firstVisibleIdx: number;
  /** Cached canvas geometry + gradients (only rebuilt when canvas size changes). */
  cache?: RenderCache;
}

interface RenderCache {
  W: number;
  H: number;
  /** Theme the cached gradients were baked for - invalidates the cache on swap. */
  paletteId: ThemeName;
  /**
   * Perspective mode the trapezoid + lane endpoints were baked for.
   * `ensureCache` invalidates on any change because switching modes
   * re-shapes the rails (converging vs parallel), per-lane endpoints
   * (laneXTop / laneXBot, separators), and the rail/highway fade
   * gradient extrapolation. Pure flag check - no runtime math cost
   * when the mode isn't changing.
   */
  perspectiveMode: PerspectiveRenderMode;
  vignette: CanvasGradient;
  highway: CanvasGradient;
  /**
   * Rail gradient stroke baked at unit accent alpha with a vertical fade
   * (0 at the new visual top, 1 inside the original highway, 0 at the
   * new visual bottom). The per-frame draw multiplies it via
   * `globalAlpha = railAlpha` so beat-pulse + milestone still drive
   * intensity without re-allocating a gradient every frame.
   */
  railGradient: CanvasGradient;
  /** Milestone vignette gradient - only recreated on resize/theme swap.
   *  Re-allocating this every frame during a milestone showed up as ~3% of
   *  total frame time in profile traces. */
  milestoneVignette: CanvasGradient;
  cx: number;
  bottomLeftX: number;
  bottomRightX: number;
  topLeftX: number;
  topRightX: number;
  topY: number;
  judgeY: number;
  /**
   * Visual top/bottom of the trapezoid AFTER the edge-fade extension.
   * Strictly visuals - note spawn/travel still keys off `topY`/`judgeY`
   * so timing perception is identical to the pre-fade version.
   *
   * `bottomY` is the unfaded bottom edge (judgeY + 50) and is used by
   * the lane separators which intentionally stop at the original extent
   * so they don't bleed into the fade zone.
   */
  topYVisual: number;
  bottomY: number;
  bottomYVisual: number;
  /**
   * Trapezoid corners EXTRAPOLATED along the existing perspective slope
   * to the new visual top/bottom. Re-derived from the same slope as the
   * rails so the fade region's left/right edges remain perfectly
   * collinear with the rails - no perspective break.
   */
  visTopLeftX: number;
  visTopRightX: number;
  visBottomLeftX: number;
  visBottomRightX: number;
  /** Per-lane judge-line X (pre-computed for particle spawn). */
  laneX: number[];
  /**
   * Per-lane TOP and BOTTOM X of the trapezoid edges. Used by the note
   * + hold-trail draw paths to interpolate a perspective-correct X
   * along the highway:
   *   x(progress) = lerp(laneXTop[lane], laneXBot[lane], 1 - progress)
   * Pre-computing the endpoints (which depend only on lane index +
   * highway geometry, both invariant per frame) drops 4 `lerp` calls
   * per visible note per frame to 1. On a dense chart with ~40 visible
   * notes that's ~160 multiplies + 80 adds eliminated per frame.
   */
  laneXTop: number[];
  laneXBot: number[];
  /**
   * Half-width (in canvas px) of a single lane at the TOP / BOTTOM
   * of the trapezoid. Used by the brutalist note + receptor draw
   * paths to size rectangles proportionally to the lane width at
   * any progress:
   *   halfWAt(progress) =
   *     lerp(laneHalfWidthTop, laneHalfWidthBot, 1 - progress)
   *     * NOTE_WIDTH_RATIO
   * In 2D mode the two values are equal (ensureCache collapses
   * `topHalf` to `bottomHalf`), so every note in a lane draws at
   * the same constant width regardless of vertical position.
   * Baked once at resize / mode-swap to kill per-note recompute.
   */
  laneHalfWidthTop: number;
  laneHalfWidthBot: number;
  /** Per-(N-1) lane separator endpoint pairs.
   *  Six `lerp()` calls per separator per frame were redundant since the
   *  highway geometry only changes on resize. Pre-baked here so the
   *  separator pass becomes a tight stroke loop. */
  separatorTopX: number[];
  separatorBotX: number[];
  /** Pre-parsed beat-dot idle color (palette.beatDotIdle). The dot draws
   *  every frame, and the previous code re-parsed the hex string every
   *  frame via `hexToRgb`. Cached here it's a one-time cost per resize/
   *  theme swap. */
  beatDotIdleRgb: RGB;
  /**
   * Pre-built `rgba()` lookup tables for the palette's accent and judge
   * colors - 256 entries each, indexed by alpha bucket. Replaces every
   * per-frame `rgba(palette.accentRgb, ...)` / `rgba(palette.judgeRgb, ...)`
   * call (judgment line, judgment-line glow shadow, lane-flash on the
   * accent-tinted floor, etc.) with a pure array lookup. Rebuilt only
   * when the palette swaps, so they're amortized to ~zero per frame.
   */
  accentRgba: string[];
  judgeRgba: string[];
  /** RGBA LUT for the off-beat (idle) beat dot. Built from
   *  `palette.beatDotIdle` - saves a per-frame `rgb(...)` shadowColor
   *  string + `rgba(...)` fill string in the upper-right beat indicator. */
  beatDotIdleRgba: string[];
}

const PARTICLE_BUDGET = 200;
const SHOCKWAVE_BUDGET = 24;
/** Pre-computed `Math.PI * 2` - used by every arc() call in the hot path
 *  (notes, gates, particles, shockwaves, beat dot). Saves a multiply per
 *  arc on dense frames (~50+ arcs/frame). */
const TAU = Math.PI * 2;
/**
 * Vertical foreshortening applied to on-highway shapes that need to
 * squash with the fret plane in 3D mode - currently the lane-gate
 * receptor height, its anticipation halo, note glow halos, and
 * shockwaves.
 *
 * Brutalist notes themselves are TRAPEZOIDS in 3D (true single-
 * vanishing-point perspective, see `drawTapNote`), so they don't
 * need this multiplier - the lane-XTop / XBot interpolation
 * already produces the correct perspective taper. This constant
 * now applies only to auxiliary circular overlays (halos,
 * shockwaves, receptor height) that are still drawn as ellipses
 * for simplicity.
 *
 * A plane tilted away by angle θ foreshortens anything on its
 * surface by cos(θ) in the viewer's vertical axis. 0.55 matches
 * the visual foreshortening of a Guitar-Hero-style highway
 * (camera ~57° above the fret plane) - overlays read as clearly
 * "laying on the fret" instead of hovering upright.
 *
 * In 2D mode this multiplier is `1` (no squash) so the same
 * overlays render as axis-aligned circles / rectangles.
 */
const PERSPECTIVE_Y_SCALE = 0.55;

/* -------------------------------------------------------------------------
 * Brutalist rectangular note geometry.
 *
 * Notes + lane receptors render as hard-edged rectangles (2D) or
 * trapezoids (3D) instead of discs / rings. Rationale:
 *
 *   1. Brand consistency - every other surface in the app (cards,
 *      buttons, modals, chips, borders) is hard-edged. Discs on the
 *      gameplay canvas were the one shape that broke the language.
 *   2. osu!mania 4K canonical look - the reference vertical-scroll
 *      4K aesthetic is rectangular notes filling ~80 % of lane width,
 *      short vertical extent, color-coded per lane. This matches
 *      exactly.
 *   3. Readability at the judge line - a rectangle crossing the line
 *      forms an edge-on-edge contact that's easier to time-read than
 *      a disc tangent. The eye locks onto the rectangle's bottom
 *      edge as the hit reference.
 *   4. Hold-note cohesion - hold trails are already rectangular
 *      ribbons; a rectangular head means the entire hold reads as
 *      one continuous shape (head → ribbon → tail) instead of
 *      mixing a disc head with a rectangular body.
 *
 * These constants are tuned so 2D and 3D read as the same instrument
 * at slightly different angles: the 3D band (14 near → 26 far) brackets
 * the 2D constant (24) so perceived rhythm spacing stays identical
 * between modes. Width is always lane-width-proportional so the notes
 * scale to any viewport instead of staying pixel-fixed.
 * --------------------------------------------------------------------- */

/**
 * Fraction of the lane's visible width that a note / receptor fills.
 * 0.82 → 9 % gutter on each side so adjacent-lane notes never visually
 * kiss at the trapezoid edges. Higher feels cramped; lower makes
 * notes read as "floating in the lane" instead of owning it.
 */
const NOTE_WIDTH_RATIO = 0.82;
/**
 * Shared tile / receptor height in canvas px.
 *
 * Notes and receptors render at the SAME on-screen size (osu!mania
 * convention - the receptor is literally a note-sized landing slot,
 * not a larger container). This matters gameplay-wise: the note's
 * leading edge sliding exactly into the receptor's leading edge is
 * the timing reference, and any size mismatch makes the cue fuzzy.
 *
 * 36 px is tuned for three constraints simultaneously:
 *   1. Enough height to fit the receptor's letter + arrow glyph
 *      stack (26 px combined, see LETTER_DY / ARROW_DY below) with
 *      breathing room on both sides.
 *   2. Rectangular notes look clearly rectangular when blurred with
 *      shadowBlur (at 6-10 px blur, a 24 px tile read as oval - the
 *      short axis got Gaussian-rounded into a pill; 36 px keeps the
 *      rectangle shape dominant).
 *   3. 16th-note spacing at 200 BPM is ~46 px on a 745 px highway
 *      at leadTime 1.2 s - with 36 px tiles that's 10 px of gap
 *      between them, still clearly readable.
 */
const NOTE_HEIGHT_2D = 36;
/** 3D mode: note height at the horizon (far end). Foreshortened so
 *  distant notes read as "further away." */
const NOTE_HEIGHT_3D_NEAR = 22;
/** 3D mode: note height at the judge line (near end). Equals
 *  `NOTE_HEIGHT_2D` so the note LOCKS to the receptor size exactly
 *  at the hit point in both modes. */
const NOTE_HEIGHT_3D_FAR = 36;
/** Lane gate (receptor) height. Equals `NOTE_HEIGHT_2D` so a note
 *  at the judge line overlays the receptor with pixel-identical
 *  dimensions - osu!mania's standard "receptor = note" convention.
 *  NOT squashed by PERSPECTIVE_Y_SCALE anymore: notes aren't
 *  height-foreshortened in 3D either (they use trapezoid WIDTH
 *  taper for perspective), so squashing the receptor would re-
 *  introduce exactly the size mismatch we're fixing. */
const GATE_HEIGHT = 36;
/** Gate border stroke width. 3 px reads as "solid brutalist edge"
 *  without the inner letter glyph getting cramped. */
const GATE_BORDER = 3;
/**
 * Circle-mode diameter as a fraction of the rect's lane-proportional
 * WIDTH (= `halfW * 2`, where `halfW = laneHalfWidth * NOTE_WIDTH_RATIO`).
 *
 * Circles are sized off the rect's WIDTH, not its HEIGHT (sizing off
 * height would leave them looking like tiny dots in a wide lane - the
 * rect dominates the lane horizontally at ~107 px on a 130 px lane at
 * the 2D judge line). At 1.0 the disc's diameter is EXACTLY the rect's
 * width, so swapping SHAPE keeps the same horizontal footprint on the
 * lane (user-requested: "make circles have same width as rectangles").
 *
 * Because the disc stays a PERFECT circle (never scaled per-axis), its
 * height also equals the rect's width - about 3x the rect's 36 px
 * height. Consecutive notes spaced closer than the disc's diameter
 * will visually overlap. At the default leadTime + BPMs we chart
 * (~220 max) that hasn't been a problem in testing, but if dense
 * bursts crumple into solid bars in the future the dial to turn is
 * here (0.85 gives a visible gutter without losing the "fills the
 * lane" read).
 *
 * Hold trails in circle mode also use this ratio (multiplied through
 * `NOTE_WIDTH_RATIO`) so the sustain ribbon matches the disc's
 * diameter exactly instead of the full lane-rect width - at 1.0 they
 * end up identical to the rect-mode ribbon, which is the intended
 * behavior when circle and rect share a horizontal footprint.
 */
const CIRCLE_WIDTH_RATIO = 1.0;

/** Lookahead window in seconds inside which a lane gate "primes" itself. */
const ANTICIPATION_WINDOW_S = 0.18;
/**
 * Fade-out durations after a note "leaves the playfield".
 *
 * IMPORTANT: these two windows must combine cleanly. A note that the
 * player ignores transitions through TWO states inside ~190ms:
 *
 *   t=0          → at the judge line (alpha 1, fully visible)
 *   t=miss−ε     → still unjudged but well past the line (grace fade)
 *   t=miss       → engine flips note.judged="miss" + records judgedAt
 *
 * If the two fades are separate, the moment the engine fires the auto-miss
 * the alpha resets back to 1 and fades a second time - that "flicker pop"
 * is exactly what reads as the note "still being there" to the player.
 *
 * Solution: take the MINIMUM of the two fades each frame. The grace fade
 * keeps decaying continuously while the judged fade tracks just-hit
 * notes that judged near the line. min() means the alpha never re-rises.
 *
 * Both use a fast ease-out curve (quadratic) so the note loses most of
 * its visual weight in the first ~40% of the window - feels snappy
 * rather than "lingering ghost note".
 */
const JUDGED_FADE_S = 0.10;
const PAST_GRACE_S = 0.16;
/**
 * Fraction of canvas height the trapezoid extends BEYOND the original
 * top and bottom edges. Used purely for visuals - gameplay math
 * (judgeY, topY, note spawn/travel timing) is unchanged.
 *
 * Top and bottom are tuned independently because they sit next to
 * very different things on screen. The top falls into empty page bg,
 * so it only needs enough room for the alpha ramp to read as a soft
 * dissolve (≈26px on an 800px tall canvas). The bottom sits right
 * below the input button row, so a heavy fade-to-transparent strip
 * looks like an oppressive black band crowding the buttons - we
 * keep the strip small AND clamp it to a non-zero alpha floor below
 * (`BOTTOM_FADE_FLOOR`) so the highway only dims at the bottom edge
 * instead of disappearing entirely.
 *
 * Earlier work landed at 4% on both sides; we tightened the top to
 * 3.2% for subtlety and the bottom to 2.4% (combined with the alpha
 * floor) so the fade no longer reads as a black band right under the
 * input buttons.
 */
const EDGE_FADE_PCT_TOP = 0.045;
const EDGE_FADE_PCT_BOTTOM = 0.038;
/**
 * Distance from `judgeY` down to where the trapezoid floor mathematically
 * ends (`bottomY`). Tuned so the buttons get a clear cushion of
 * fully-opaque highway BEFORE the fade begins. Combined with the
 * reduced `EDGE_FADE_BLEED` below, the alpha=1 anchor now sits at
 * ≈`bottomY - 17px`, so the visible darkening starts ~85px below
 * `judgeY` and the perceptual midpoint sits ~108px below it - well
 * separated from the input buttons so the dissolve never reads as
 * crowding or covering them.
 */
const BOTTOM_HIGHWAY_PAD = 100;
/**
 * Lowest alpha the highway / rails fade to at the very bottom edge.
 * Now true 0 - any non-zero floor leaves the trapezoid's bottom edge
 * visible as a dim shelf, which is exactly the "block" look we kept
 * fighting. With the short `BOTTOM_HIGHWAY_PAD` + tight ramp this
 * dissolves cleanly to nothing within ~25px of the buttons, no
 * residual silhouette.
 */
const BOTTOM_FADE_FLOOR = 0;
/**
 * How far the alpha ramp bleeds INTO the original highway area, as a
 * fraction of the new fade strip height. 0 = fade is contained strictly
 * to the new strip (looks abrupt because both surfaces are similar
 * tones); 1.0 = fade is twice as wide, half inside the new strip and
 * half inside the original highway. 0.45 keeps the alpha=1 anchor
 * close to `bottomY` rather than creeping back toward the buttons,
 * which is what visually separates the dissolve from the button
 * row. The wider `EDGE_FADE_PCT_BOTTOM` strip compensates so the
 * ramp itself still spans ~55px on a typical 800px canvas - long
 * enough that the eye reads it as a smooth gradient rather than a
 * crisp boundary.
 */
const EDGE_FADE_BLEED = 0.45;
/**
 * Top-of-progress threshold inside which notes (and beat lines) ramp
 * their alpha from 0 → 1 as they enter the highway. Reads as the note
 * "materializing" onto the floor instead of popping in at full alpha.
 *
 * 0.95 means the fade happens across the first 5% of progress; on a
 * 1.2s leadTime (osu AR5, our default) that's ~60ms which is exactly
 * the "very quick" window - fast enough to feel snappy, long enough
 * to kill the pop. The same constant is reused for hold-trail head
 * fade and beat-line top fade so all three top-edge effects stay in
 * sync.
 */
const SPAWN_FADE_PROGRESS = 0.95;
/** Combo thresholds that trigger a screen-wide milestone flash. */
const COMBO_MILESTONES = [25, 50, 100, 200, 350, 500, 750, 1000] as const;

/**
 * Pre-parsed lane colors. `withAlpha("#3da9ff", a)` does 3 parseInts every
 * call; the particle hot loop calls it ~200×/frame. Pre-parsing once and
 * using a templated rgba() string drops that to a single string concat.
 */
interface RGB { r: number; g: number; b: number; }
const LANE_RGB: RGB[] = LANE_COLORS.map(hexToRgb);

function rgba(c: RGB, a: number): string {
  return `rgba(${c.r},${c.g},${c.b},${a})`;
}

/* -------------------------------------------------------------------------
 * Per-frame string allocation killers.
 *
 * Profiling showed that the particle hot loop alone produced ~200
 * `rgba()` strings per frame (≈12k allocations / sec @ 60Hz). At dense
 * particle bursts this generated enough short-lived garbage to trigger
 * minor GC pauses every few seconds - the classic source of "fine for
 * 5s, then a 30ms hitch" stutters in canvas games.
 *
 * Fix: pre-compute `LANE_RGBA[lane][alphaBucket]` once at module load -
 * 4 lanes × 256 alpha buckets = 1024 strings, ~25KB resident, ZERO
 * per-frame allocations. Alpha is quantized to 1/255 which is exactly
 * the precision the GPU uses for the 8-bit alpha channel anyway, so
 * there's no visual difference vs the unquantized form.
 *
 * Same trick applied to per-palette colors (accent / judge) via
 * `makeRgbaLut` - those luts live on the cache and rebuild only on
 * resize / theme swap, so they're free at frame time too.
 *
 * Hot-path call sites should use:
 *   - `laneRgba(lane, a)` for lane-colored draws (notes, holds, particles,
 *     gates, lane flashes, shockwaves)
 *   - `rgbaFromLut(cache.accentRgba, a)` for accent draws (judge-line glow,
 *     judgment-line stroke shadow, etc.)
 *   - `rgbaFromLut(cache.judgeRgba, a)` for judgment-line stroke
 *
 * Cold paths (one-off colors per frame, gradient stop bake, popup grades)
 * keep using `rgba()` since the savings would be invisible.
 * --------------------------------------------------------------------- */
const ALPHA_STEPS = 256;

function makeRgbaLut(c: RGB): string[] {
  const arr = new Array<string>(ALPHA_STEPS);
  for (let i = 0; i < ALPHA_STEPS; i++) {
    arr[i] = `rgba(${c.r},${c.g},${c.b},${(i / 255).toFixed(3)})`;
  }
  return arr;
}

function rgbaFromLut(lut: string[], a: number): string {
  // Truncating bucket. Branchless clamp on the high end keeps the
  // hot path free of conditional jumps; alpha < 0 collapses to 0
  // because `(neg * 255) | 0` rounds toward zero.
  let i = (a * 255) | 0;
  if (i < 0) i = 0;
  else if (i > 255) i = 255;
  return lut[i];
}

const LANE_RGBA: string[][] = LANE_RGB.map(makeRgbaLut);

function laneRgba(lane: number, a: number): string {
  return rgbaFromLut(LANE_RGBA[lane], a);
}

// White-with-alpha LUT, used for "shine" overlays (gate label glow,
// shockwave white core). Same allocation-elimination pattern as
// LANE_RGBA - saves a `toFixed(3)` + template-literal allocation per
// affected draw per frame, which matters because the shine fires on
// every active lane on every keypress.
const WHITE_SHINE_RGBA: string[] = makeRgbaLut({ r: 255, g: 255, b: 255 });

function whiteShineRgba(a: number): string {
  return rgbaFromLut(WHITE_SHINE_RGBA, a);
}

function hexToRgb(hex: string): RGB {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

export const DEFAULT_RENDER_OPTIONS: RenderOptions = {
  // osu!standard AR5 (1200 ms preempt) - osu's "medium" tier, the
  // documented default. Sits squarely between Guitar Hero's ~1.0-1.2 s
  // arcade baseline and osu!mania's 0.8-1.5 s player range, so neither
  // audience reads it as wrong. Scoring and hit windows live elsewhere;
  // this is purely a scroll-speed / visibility knob.
  //
  // If scroll speed is ever exposed as a player setting, the osu AR
  // ladder (AR0 1.8s → AR11 0.3s) is the natural option ladder, with
  // AR5 staying as the default.
  leadTime: 1.2,
  laneHeld: new Array(TOTAL_LANES).fill(false),
  judgeLineY: 0.82,
  bpm: 161,
  offset: 0.18,
  theme: "dark",
  // Default to PERFORMANCE so the very first frame (before the React
  // effect mirrors the persisted setting in) doesn't briefly render
  // the heavy VFX path on machines that can't afford it. Players who
  // chose HIGH still see HIGH from frame 1 because the load happens
  // synchronously in the React state initialiser.
  quality: "performance",
  // Default to "2d" (flat, osu!-style) so the very first frame on a
  // fresh install renders without the perspective taper that some
  // players found disorienting. The React state initialiser loads
  // the persisted preference synchronously, so returning players
  // who switched to "3d" see their chosen mode from frame 1 too.
  perspectiveMode: "2d",
  // Default to "rect" (brutalist tiles) because it matches the rest
  // of the app's hard-edged design language and the osu!mania 4K
  // canonical look. Players who prefer the classic disc aesthetic
  // can flip to "circle" from the StartCard / HUD / Lobby tile.
  noteShape: "rect",
};

/**
 * Allocate a fresh `RenderState`. Use this from the React side rather than
 * hand-rolling the literal so we can add fields without touching every
 * caller.
 */
export function createRenderState(): RenderState {
  return {
    recentEvents: [],
    laneFlash: new Array(TOTAL_LANES).fill(0),
    laneAnticipation: new Array(TOTAL_LANES).fill(0),
    particles: [],
    shockwaves: [],
    pendingHits: [],
    combo: 0,
    milestone: null,
    firstVisibleIdx: 0,
  };
}

/**
 * Pre-compile every hot draw path AND build the gradient cache so the
 * first real in-game frame doesn't pay for either.
 *
 * Why this exists:
 *   On the very first frame after `audio.start()` fires, the renderer
 *   has to do TWO expensive things at once:
 *     1. Build the per-canvas-size gradient cache (`ensureCache`):
 *        ~10 createLinearGradient / createRadialGradient calls plus a
 *        bunch of trapezoid math. Measured at 8–25 ms on a mid-range
 *        laptop, longer on integrated GPUs.
 *     2. JIT-compile drawTapNote / drawHoldNote / drawJudgmentText /
 *        the particle path. V8 keeps these in the interpreter until
 *        they're called several times - the very first call can spend
 *        4–10 ms in the parse+baseline tier alone.
 *
 *   Combined that's a 12–35 ms hitch on the EXACT frame the song begins,
 *   which lands as a visible stutter right when the player is most
 *   primed to notice it (audio onset draws all attention to the screen).
 *
 *   This helper draws ONE synthetic frame containing a tap + a hold +
 *   one of each judgment popup, so the cache lands in `rs.cache` and
 *   every code path the loop will hit is already in the optimized tier
 *   by the time the first real note draws. The synthetic geometry is
 *   then wiped from the canvas (`clearRect`) so nothing leaks visually,
 *   even on the rare case the loading overlay isn't covering yet.
 *
 * Pollution safety:
 *   The draw mutates RenderState in-place (lane flashes decay,
 *   pendingHits drain into particles, etc.). To keep the real `rs`
 *   pristine we draw into a throwaway state with a fresh particles /
 *   pendingHits / etc., then COPY ONLY the gradient cache back to the
 *   caller's `rs`. The cache is the only thing we want to survive.
 *
 * Idempotent: cheap to call repeatedly (a single ~3-tap-equivalent
 * draw). Game.tsx and MultiGame.tsx both call it from their canvas
 * resize effect, which fires once on mount and again on any DPR /
 * theme / size change.
 */
export function prewarmRenderer(
  ctx: CanvasRenderingContext2D,
  opts: RenderOptions,
  realRs: RenderState,
): void {
  // Synthetic chart designed to exercise EVERY hot draw path the live
  // loop will hit:
  //   - 1 tap RIGHT at the judge line (t inside ANTICIPATION_WINDOW_S,
  //     0.18s) → forces drawLaneGate's anticipation pulse path so the
  //     first real "incoming note" doesn't pay JIT for that branch.
  //   - 1 tap mid-highway → standard drawTapNote path.
  //   - 1 hold mid-highway → drawHoldTrail path.
  // All three are positive songTime so they render above the judge
  // line at songTime = 0.
  const syntheticNotes: Note[] = [
    { id: -100, t: 0.10, lane: 1 },
    { id: -101, t: 0.5,  lane: 0 },
    { id: -102, t: 0.7,  endT: 0.95, lane: 2 },
  ];
  const syntheticState = new GameState(syntheticNotes);
  // Seed one of EACH judgment popup, one tail-judgment popup
  // (`tail: true` exercises the "PERFECT·HOLD" label path), and one
  // generic judgment so drawJudgmentPopups warms text metrics for
  // every per-grade color + label combination it'll later hit.
  syntheticState.events = [
    { noteId: -201, lane: 0, judgment: "perfect", delta: 0,    at: -0.05 },
    { noteId: -202, lane: 1, judgment: "great",   delta: 0.02, at: -0.05 },
    { noteId: -203, lane: 2, judgment: "good",    delta: 0.04, at: -0.05 },
    { noteId: -204, lane: 3, judgment: "miss",    delta: 0.20, at: -0.05 },
    { noteId: -205, lane: 2, judgment: "perfect", delta: 0,    at: -0.05, tail: true },
  ];

  // Throwaway RenderState - keeps the caller's particles / pendingHits /
  // milestone untouched. We pre-charge:
  //   - pendingHits: one per judgment so drainHits spawns particles +
  //     shockwaves of every flavor (warms updateAndDrawParticles +
  //     updateAndDrawShockwaves end-to-end).
  //   - laneFlash: every lane non-zero so the "kiss under judgment line"
  //     gradient path runs for all four lanes.
  //   - laneAnticipation: every lane non-zero so the gate's
  //     anticipation halo path is JIT'd.
  //   - combo + milestone: triggers drawMilestoneVignette + the
  //     drawCanvasCombo number-rendering path (digits, kerning).
  const throwawayRs: RenderState = {
    recentEvents: syntheticState.events,
    laneFlash: new Array(TOTAL_LANES).fill(0.6),
    laneAnticipation: new Array(TOTAL_LANES).fill(0.6),
    particles: [],
    shockwaves: [],
    pendingHits: [
      { lane: 0, judgment: "perfect" },
      { lane: 1, judgment: "great" },
      { lane: 2, judgment: "good" },
      { lane: 3, judgment: "miss" },
    ],
    combo: 100,
    milestone: { strength: 0.8, combo: 100 },
    firstVisibleIdx: 0,
    cache: realRs.cache,
  };

  try {
    drawFrame(ctx, syntheticState, 0, 0.016, opts, throwawayRs);
  } catch {
    // Pre-warm is best-effort. If the canvas is in a weird state mid-
    // resize, the next real frame will rebuild the cache from scratch.
    return;
  }

  // Move the freshly-built cache to the real rs so the live loop hits
  // a warm cache on its first frame. Everything else (particles spawned
  // from the pendingHit, the synthetic combo number, etc.) stays trapped
  // in the throwaway and is discarded with it.
  realRs.cache = throwawayRs.cache;

  // Wipe the canvas so nothing the prewarm drew is visible - both
  // Game.tsx and MultiGame.tsx have an overlay above the canvas
  // during the prewarm window, but clearing belt-and-suspenders means
  // we're safe even on the brief frame between mount and overlay paint.
  // The clear uses the canvas's BACKING-store size (which we set with
  // setTransform(dpr,...) in the resize handler), so passing W*H from
  // ctx.canvas covers every drawn pixel regardless of DPR.
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();
}

/**
 * Returns true if `prevCombo → newCombo` crossed any milestone threshold.
 * Used by Game / MultiGame to know when to flash + chime.
 */
export function crossedComboMilestone(
  prevCombo: number,
  newCombo: number,
): number | null {
  for (const m of COMBO_MILESTONES) {
    if (prevCombo < m && newCombo >= m) return m;
  }
  return null;
}

/**
 * Draw one frame. Coordinates are CSS pixels - caller pre-applies devicePixelRatio
 * scaling via ctx.setTransform so we draw in logical units.
 *
 * Performance notes:
 *   - All static gradients (vignette, highway floor) are cached in `rs.cache`
 *     and only rebuilt when the canvas is resized. Allocating Skia gradient
 *     objects every frame was the single biggest source of GC pressure.
 *   - Note iteration uses an early-out when the next lookahead is past the
 *     screen, so even charts with thousands of notes stay O(visible).
 *   - `dt` is the wall-clock delta between frames; caller should clamp it
 *     after pause/tab-restore so particles don't teleport.
 */
export function drawFrame(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  songTime: number,
  dt: number,
  opts: RenderOptions,
  rs: RenderState,
  /**
   * Logical canvas size (CSS pixels). Caller passes the most-recently
   * observed size from the resize handler / ResizeObserver, so the
   * hot path doesn't have to read `ctx.canvas.clientWidth` /
   * `clientHeight` every frame.
   *
   * Reading those `client*` getters forces a layout flush in any
   * browser engine that has a pending style invalidation - Chrome's
   * tracing showed it as ~0.1–0.4 ms per frame on contended layout
   * pages (hot canvas + a sibling React subtree just re-rendered).
   * Dropping the reads removes that variance entirely.
   *
   * Falls back to `ctx.canvas.clientWidth` / `clientHeight` when
   * either argument is omitted or non-positive - keeps legacy
   * call-sites (`prewarmRenderer`'s synthetic frame, any future
   * embedder that doesn't track size) working unchanged.
   */
  width?: number,
  height?: number,
): void {
  const W =
    width != null && width > 0 ? width : ctx.canvas.clientWidth;
  const H =
    height != null && height > 0 ? height : ctx.canvas.clientHeight;
  const palette = getPalette(opts.theme);
  const perf = opts.quality === "performance";
  const cache = ensureCache(ctx, rs, W, H, palette, opts);

  // Clear to fully-transparent (NOT opaque pageBg) so the underlying
  // body background shows through. The body uses `rgb(var(--bg))`
  // which is wired into the same 220ms cubic-bezier theme transition
  // that fades the header / footer / landing-page surface - so the
  // gameplay-area bg now crossfades in lockstep with the rest of the
  // app on a theme swap, instead of hard-cutting in one frame the
  // moment React's `theme` state flips.
  //
  // Sanity check on visual parity (both modes are pixel-identical to
  // the previous opaque-fill version):
  //   - Dark : was pageBg #050608 + vignette rgba(0,0,0,0.85) overlay.
  //            Now: clear + same vignette composited over body
  //            #050608 yields the same near-black corners.
  //   - Light: was pageBg #f5f5f0 + transparent vignette (we already
  //            zeroed the alpha to fix the gray-box bug). Now: clear
  //            + transparent vignette → body #f5f5f0 shows through.
  //
  // We deliberately keep `palette.pageBg` in the type for future
  // renderers that may need it (e.g. any code that needs to know the
  // "true" background color for blending math); the fact that
  // drawFrame no longer paints it is documented above the field.
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = cache.vignette;
  ctx.fillRect(0, 0, W, H);

  // The old code allocated a fresh `Highway` object every frame here
  // (just to hand a few cached numbers to drawHighway / drawTapNote /
  // drawHoldTrail). On long sessions those tiny per-frame allocations
  // were a real GC contributor - now we just thread `cache` through
  // the call sites and read the numbers off it directly. Zero allocs
  // per frame on the geometry-passing path.
  const beatLen = 60 / opts.bpm;
  const firstBeat =
    Math.floor((songTime - opts.offset) / beatLen) * beatLen + opts.offset;
  const beatsToDraw = Math.ceil(opts.leadTime / beatLen) + 2;

  const phase = ((songTime - opts.offset) % beatLen + beatLen) % beatLen;
  const beatProgress = phase / beatLen;
  const beatPulse = Math.pow(1 - beatProgress, 3);
  const isDownbeat =
    Math.round((songTime - opts.offset) / beatLen) % 4 === 0;

  // Particles + shockwaves are pure celebration VFX - gameplay is
  // identical without them, so `performance` mode skips drainHits
  // (which spawns both) AND the corresponding draw passes. We
  // still clear the pendingHits queue so the engine's per-hit push
  // doesn't accumulate forever; same for particles / shockwaves
  // in case the player flipped the toggle mid-match while pools
  // were non-empty.
  if (!perf) {
    drainHits(rs, cache);
  } else {
    rs.pendingHits.length = 0;
    if (rs.particles.length) rs.particles.length = 0;
    if (rs.shockwaves.length) rs.shockwaves.length = 0;
  }
  decayMilestone(rs, dt);

  // Per-frame ambient breath modulation for tap-note halos (quality
  // mode only). Computed ONCE here and threaded into drawHighway →
  // drawTapNote so the per-note loop doesn't recompute the same
  // sin() ~20× per frame on dense charts. In performance mode the
  // breath is unused (no glow path runs) - pass 1 so the math stays
  // a no-op for callers that don't gate on `perf`.
  //
  // 0.9 ± 0.1 sweeps the halo's globalAlpha between 0.8 and 1.0
  // (was 0.4-1.0). The previous 60 % swing dimmed dots noticeably
  // every cycle - it read as the highway "blinking", and combined
  // with all dots breathing in unison it added to the dizzy
  // sensation players were reporting on dense charts. The new
  // ±10 % swing is a soft shimmer the eye reads as "alive" without
  // a visible brightness pulse, so the dots never look washed out.
  //
  // The COLORED RING under the halo is no longer modulated by
  // breath at all (see drawTapNote - the solid fill is drawn before
  // the halo at the note's intrinsic alpha). So the breath here ONLY
  // affects the soft outer halo glow - exactly the layer that
  // SHOULD breathe, leaving the rhythm-critical inner ring bright
  // and saturated 100 % of the time.
  //
  // ω = 0.9 rad/s → ~7.0 s full cycle (was ~4.8 s). Slowing the
  // pulse down further reduces the synchronized whole-screen
  // throbbing that was contributing to the dizziness - the rate is
  // now slower than human breathing (~12-20 cycles/min ≈ 3-5 s),
  // so it reads as ambient atmosphere rather than something
  // demanding attention.
  const breath = perf ? 1 : 0.9 + 0.1 * Math.sin(songTime * 0.9);

  drawHighway(
    ctx, state, songTime, opts, rs,
    firstBeat, beatLen, beatsToDraw, beatPulse, isDownbeat, cache, palette, perf, breath,
  );

  if (!perf) {
    updateAndDrawShockwaves(ctx, rs, dt, palette, opts);
    updateAndDrawParticles(ctx, rs, dt);
  }

  drawCanvasCombo(ctx, rs, cache, palette, perf);
  drawJudgmentPopups(ctx, rs.recentEvents, songTime, cache.judgeY - 50, cache, perf);
  drawBeatDot(ctx, W - 28, 28, beatPulse, isDownbeat, palette, cache, perf);
  if (!perf) {
    drawMilestoneVignette(ctx, rs, W, H, cache);
  }
}

function decayMilestone(rs: RenderState, dt: number): void {
  const m = rs.milestone;
  if (!m) return;
  // ~700ms full decay (1 / 1.45 ≈ 0.69s).
  m.strength -= dt * 1.45;
  if (m.strength <= 0) rs.milestone = null;
}

// ---------------------------------------------------------------------------
function ensureCache(
  _ctx: CanvasRenderingContext2D,
  rs: RenderState,
  W: number,
  H: number,
  palette: ThemePalette,
  opts: RenderOptions,
): RenderCache {
  if (
    rs.cache &&
    rs.cache.W === W &&
    rs.cache.H === H &&
    rs.cache.paletteId === palette.id &&
    rs.cache.perspectiveMode === opts.perspectiveMode
  ) {
    return rs.cache;
  }

  // Vertical placement of the playfield. `topY` + `judgeY` were
  // translated down together by ~4% of H vs the pre-tweak placement
  // (0.05 / 0.78 → 0.09 / 0.82) so the highway sits lower in its
  // container - gives the score / settings cards visible breathing
  // room above the trapezoid and soaks up the previously-empty black
  // band beneath the lane gates. Playfield HEIGHT is unchanged
  // (judgeY - topY ≈ 0.73 * H in both versions), so note travel
  // time, perspective, and every other y-derived constant stay
  // identical - this is a pure translate.
  const judgeY = H * opts.judgeLineY;
  const topY = H * 0.09;
  const cx = W / 2;
  // Highway sizing.
  //
  // We cap the half-width at 264 (was 294) AND scale by 0.31 of viewport
  // width (was 0.336) so the trapezoid leaves more breathing room for the
  // side HUD panels (score/combo, rock-meter, LIVE scoreboard). On wide
  // screens (≥ ~880px) the cap kicks in and the highway is fixed at
  // 528px wide; on narrower viewports it shrinks proportionally so the
  // side cards never crowd the gameplay area regardless of window size.
  // The 10% reduction in playable width is barely perceptible during
  // gameplay (lanes scale together, judgment line still hits at the same
  // y) but materially fixes the "boxes touching the highway" feel that
  // the original 294/0.336 numbers produced on common laptop sizes.
  const bottomHalf = Math.min(264, W * 0.31);
  // Perspective switch - the ONE number that changes the entire
  // highway geometry.
  //
  //   - "3d" → topHalf = bottomHalf * 0.5 (the trapezoid the game
  //            has always shipped with - rails converge, per-lane
  //            endpoints differ top vs bottom, beat lines taper).
  //   - "2d" → topHalf = bottomHalf       (rectangle - rails are
  //            vertical, per-lane top/bottom X collapse to the
  //            same column, beat lines stay full-width).
  //
  // Every downstream derived value (rail slope, lane X arrays,
  // separator endpoints, fade-zone extrapolation) reads from
  // topHalf/topLeftX/topRightX transparently, so no other code
  // in ensureCache needs to branch on the mode.
  const topHalf = opts.perspectiveMode === "2d" ? bottomHalf : bottomHalf * 0.5;
  const bottomLeftX = cx - bottomHalf;
  const bottomRightX = cx + bottomHalf;
  const topLeftX = cx - topHalf;
  const topRightX = cx + topHalf;

  const ctx = _ctx;

  const vignette = ctx.createRadialGradient(
    W / 2, H * 0.5, Math.min(W, H) * 0.25,
    W / 2, H * 0.5, Math.max(W, H) * 0.85,
  );
  vignette.addColorStop(0, "rgba(0,0,0,0)");
  vignette.addColorStop(1, palette.vignetteOuter);

  // Visual edge extension. The trapezoid's geometric "play area" stays
  // anchored at topY → bottomY - that's where notes live and where
  // the rails *used* to terminate. We extend outward by
  // `EDGE_FADE_PCT_TOP / _BOTTOM` of H on each side and use that
  // extra strip purely for the fade-to-transparent so the highway
  // melts into the page bg instead of having a hard edge. The two
  // sides are sized independently so the bottom (next to the input
  // button row) can be tighter than the top. Clamped to the canvas
  // so we never try to draw past the surface even on extreme aspect
  // ratios.
  const bottomY = judgeY + BOTTOM_HIGHWAY_PAD;
  const fadePxTop = H * EDGE_FADE_PCT_TOP;
  const fadePxBottom = H * EDGE_FADE_PCT_BOTTOM;
  const topYVisual = Math.max(0, topY - fadePxTop);
  const bottomYVisual = Math.min(H, bottomY + fadePxBottom);

  // Extrapolate the trapezoid corners along the existing rail slope so
  // the fade-zone widening matches the perspective EXACTLY. If we just
  // pushed the corners straight up/down we'd get a tiny "step" where
  // the rails meet the fade region - the eye picks that up immediately.
  const slope = (bottomHalf - topHalf) / (bottomY - topY);
  const visTopHalf = Math.max(0, topHalf - slope * (topY - topYVisual));
  const visBottomHalf = bottomHalf + slope * (bottomYVisual - bottomY);
  const visTopLeftX = cx - visTopHalf;
  const visTopRightX = cx + visTopHalf;
  const visBottomLeftX = cx - visBottomHalf;
  const visBottomRightX = cx + visBottomHalf;

  // Highway gradient - spans the FULL visual extent (including the
  // fade zones) and uses rgba so we can fade alpha to 0 at the very
  // top and very bottom.
  //
  // The "fully opaque" stops are placed PAST the original top/bottom
  // by EDGE_FADE_BLEED of the strip width, so the alpha ramp visibly
  // covers (a) the entire new strip plus (b) a small slice of the
  // original highway. Without this bleed the ramp is contained inside
  // a ~32px strip whose start AND end pixels are visible against the
  // page bg simultaneously - the eye picks the ramp endpoints out as
  // two faint horizontal lines instead of "no edge". With the bleed,
  // the alpha-1 anchor sits well inside the highway and the ramp
  // gradient looks like a single smooth dissolve.
  //
  // The mid color stop is repositioned so its relative spacing INSIDE
  // the original highway area is preserved (the 0.7 stop still sits
  // 70% of the way down the original gradient, not 70% of the way
  // down the extended gradient).
  // Guard the divisor so the strip ratios stay finite. On degenerate
  // canvas sizes (W or H = 0 during a phase remount; ResizeObserver
  // firing on a still-collapsed container; the multiplayer canvas
  // briefly hidden behind the loading screen) the visible top + bottom
  // extents collapse to the same y, totalH becomes 0, and the divisions
  // below produce NaN. NaN then propagates through `clamp` (which is
  // NaN-pass-through with `<` / `>` comparisons) into `addColorStop`,
  // which the spec mandates throw `TypeError: non-finite double` for
  // anything but a finite [0, 1] number - taking down the entire
  // render frame. Clamping to ≥1 keeps the math finite; the rendered
  // gradient is briefly degenerate but the next ensureCache() rebuild
  // (with real dimensions) corrects it.
  const totalH = Math.max(1, bottomYVisual - topYVisual);
  const stripTop = (topY - topYVisual) / totalH;       // start of original area
  const stripBot = (bottomY - topYVisual) / totalH;    // end of original area
  // Compute strip heights independently so a canvas tall enough to
  // clamp `topYVisual` to 0 (or `bottomYVisual` to H) still picks
  // bleed values that are proportional to the ACTUAL strip on each
  // side rather than assuming top/bottom strips are equal.
  const stripHTop = stripTop;
  const stripHBot = 1 - stripBot;
  // Clamp every computed stop to [0, 1] before handing it to
  // addColorStop. On extreme aspect ratios (very short viewports, the
  // multiplayer side panels at narrow widths, certain zoom × DPR
  // combinations) the layout produces `bottomY > H` or `topY < fadePxTop`,
  // which makes `stripBot > 1` or `stripTop > 1/(1+EDGE_FADE_BLEED)`.
  // Either case yields a stop slightly outside [0, 1] (e.g. 1.0105),
  // and the spec mandates `addColorStop` throw `IndexSizeError` for
  // anything out of range. The throw aborts the entire frame paint, so
  // affected players see a permanently blank highway in solo AND multi.
  // Clamping is safe: `addColorStop` sorts stops internally, so two
  // stops landing at exactly 1.0 just terminate the gradient cleanly.
  const fadeTopAnchor = clamp(stripTop + stripHTop * EDGE_FADE_BLEED, 0, 1);
  const fadeBotAnchor = clamp(stripBot - stripHBot * EDGE_FADE_BLEED, 0, 1);
  const innerMid = clamp(
    fadeTopAnchor + 0.7 * (fadeBotAnchor - fadeTopAnchor),
    0,
    1,
  );
  const stop0 = hexToRgb(palette.highwayStops[0]);
  const stop1 = hexToRgb(palette.highwayStops[1]);
  const stop2 = hexToRgb(palette.highwayStops[2]);
  const highway = ctx.createLinearGradient(0, topYVisual, 0, bottomYVisual);
  highway.addColorStop(0, rgba(stop0, 0));
  highway.addColorStop(fadeTopAnchor, rgba(stop0, 1));
  highway.addColorStop(innerMid, rgba(stop1, 1));
  highway.addColorStop(fadeBotAnchor, rgba(stop2, 1));
  // Bottom dissolves to `BOTTOM_FADE_FLOOR` instead of 0 - keeps a
  // faint highway tone behind the input buttons so the fade reads as
  // a soft dim instead of a hard fade-to-bg band right under them.
  highway.addColorStop(1, rgba(stop2, BOTTOM_FADE_FLOOR));

  // Rail gradient - same fade anchors at unit accent alpha so the
  // rails fade in/out in lockstep with the highway floor. Per-frame
  // rail draw sets `globalAlpha = railAlpha` which scales the WHOLE
  // gradient (including the gradient's own alpha stops); the
  // rails-to-floor alignment is therefore exact regardless of
  // beat-pulse strength. One allocation per resize/theme.
  const railGradient = ctx.createLinearGradient(0, topYVisual, 0, bottomYVisual);
  railGradient.addColorStop(0, rgba(palette.accentRgb, 0));
  railGradient.addColorStop(fadeTopAnchor, rgba(palette.accentRgb, 1));
  railGradient.addColorStop(fadeBotAnchor, rgba(palette.accentRgb, 1));
  // Mirror the highway's bottom floor so the rails dim in lockstep
  // with the floor instead of vanishing entirely under the buttons.
  railGradient.addColorStop(1, rgba(palette.accentRgb, BOTTOM_FADE_FLOOR));

  const laneX: number[] = [];
  const laneXTop: number[] = [];
  const laneXBot: number[] = [];
  for (let i = 0; i < MAIN_LANE_COUNT; i++) {
    const f = (i + 0.5) / MAIN_LANE_COUNT;
    // Bottom (= judge-line) X is what particles + lane gates use.
    laneX.push(lerp(bottomLeftX, bottomRightX, f));
    // Top + bottom edges of the trapezoid for this lane - used by
    // drawTapNote / drawHoldTrail to lerp the X along note progress
    // without re-deriving the endpoints per note per frame.
    laneXTop.push(lerp(topLeftX, topRightX, f));
    laneXBot.push(lerp(bottomLeftX, bottomRightX, f));
  }
  // Single-lane half-widths at the top / bottom of the trapezoid.
  // Both are positive numbers regardless of perspective mode because
  // in 2D the endpoints collapse (topLeftX → bottomLeftX), making
  // the two half-widths equal. Used by every rectangular draw path
  // (notes, holds, receptors) so width stays lane-proportional.
  const laneHalfWidthTop =
    (topRightX - topLeftX) / (MAIN_LANE_COUNT * 2);
  const laneHalfWidthBot =
    (bottomRightX - bottomLeftX) / (MAIN_LANE_COUNT * 2);
  const separatorTopX: number[] = [];
  const separatorBotX: number[] = [];
  for (let i = 1; i < MAIN_LANE_COUNT; i++) {
    const f = i / MAIN_LANE_COUNT;
    separatorTopX.push(lerp(topLeftX, topRightX, f));
    separatorBotX.push(lerp(bottomLeftX, bottomRightX, f));
  }

  // Pre-bake the milestone vignette with a unit-alpha outer stop. We
  // multiply by `globalAlpha` per draw to scale the flash strength
  // instead of re-allocating a gradient with new color stops every
  // frame (the gradient takes a non-trivial amount of work to create
  // - caching it dropped milestone-active frames from ~6.5ms to ~5.2ms
  // on a Ryzen 5 / 1080p test rig).
  const milestoneVignette = ctx.createRadialGradient(
    W / 2, H * 0.55, Math.min(W, H) * 0.25,
    W / 2, H * 0.55, Math.max(W, H) * 0.85,
  );
  milestoneVignette.addColorStop(0, "rgba(0,0,0,0)");
  milestoneVignette.addColorStop(1, rgba(palette.accentRgb, 1));

  rs.cache = {
    W, H,
    paletteId: palette.id,
    perspectiveMode: opts.perspectiveMode,
    vignette, highway, railGradient, milestoneVignette,
    cx, bottomLeftX, bottomRightX, topLeftX, topRightX,
    topY, judgeY,
    topYVisual, bottomY, bottomYVisual,
    visTopLeftX, visTopRightX, visBottomLeftX, visBottomRightX,
    laneX, laneXTop, laneXBot,
    laneHalfWidthTop, laneHalfWidthBot,
    separatorTopX, separatorBotX,
    beatDotIdleRgb: hexToRgb(palette.beatDotIdle),
    accentRgba: makeRgbaLut(palette.accentRgb),
    judgeRgba: makeRgbaLut(palette.judgeRgb),
    beatDotIdleRgba: makeRgbaLut(hexToRgb(palette.beatDotIdle)),
  };
  return rs.cache;
}

// ---------------------------------------------------------------------------
function drawHighway(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  songTime: number,
  opts: RenderOptions,
  rs: RenderState,
  firstBeat: number,
  beatLen: number,
  beatsToDraw: number,
  beatPulse: number,
  isDownbeat: boolean,
  cache: RenderCache,
  palette: ThemePalette,
  perf: boolean,
  breath: number,
) {
  // Trapezoid floor - drawn at the EXTENDED visual extent so the
  // baked highway gradient can fade alpha to 0 at top and bottom. The
  // gameplay area (where notes live) still occupies topY → judgeY+50;
  // everything outside that band is the fade strip.
  ctx.beginPath();
  ctx.moveTo(cache.visTopLeftX, cache.topYVisual);
  ctx.lineTo(cache.visTopRightX, cache.topYVisual);
  ctx.lineTo(cache.visBottomRightX, cache.bottomYVisual);
  ctx.lineTo(cache.visBottomLeftX, cache.bottomYVisual);
  ctx.closePath();
  ctx.fillStyle = cache.highway;
  ctx.fill();

  // Rails - fixed neon glow, no beat-pulse / milestone / downbeat
  // modulation. Earlier versions ramped `railAlpha`, `railBlur` and
  // `lineWidth` against `beatPulse` to "react" to the music, but at
  // 161 BPM that's ~2.7 alpha+blur swings per second on the most
  // visually dominant element on screen - extremely distracting and
  // exactly what the player called out as "constantly flashing".
  // The judgment line still pulses (it's narrow and subtle), and the
  // milestone vignette still flashes the whole canvas tinted on
  // combo milestones, so the music-reactive feedback isn't lost - it
  // just isn't competing with the rails for attention anymore.
  //
  // Strokestyle uses the CACHED `railGradient` (baked once per
  // resize/theme at unit accent alpha with vertical 0→1→0 fade) so
  // the rails meet the highway floor's fade-to-transparent exactly
  // at topYVisual / bottomYVisual without per-frame allocation.
  ctx.save();
  ctx.lineWidth = 3;
  ctx.strokeStyle = cache.railGradient;
  // Rails carry the brand glow; in performance mode we drop the
  // shadowBlur (the single most expensive operation per stroke on
  // integrated GPUs) and let the gradient stroke alone read as the
  // accent. Same color identity, no offscreen pass per draw.
  if (!perf) {
    ctx.shadowColor = rgbaFromLut(cache.accentRgba, 0.95);
    ctx.shadowBlur = 22;
  }
  ctx.beginPath();
  ctx.moveTo(cache.visTopLeftX, cache.topYVisual);
  ctx.lineTo(cache.visBottomLeftX, cache.bottomYVisual);
  ctx.moveTo(cache.visTopRightX, cache.topYVisual);
  ctx.lineTo(cache.visBottomRightX, cache.bottomYVisual);
  ctx.stroke();
  ctx.restore();
  // `ms` is still consumed by the judgment-line pulse below, so we
  // resolve it here even though the rails no longer need it.
  const ms = rs.milestone?.strength ?? 0;

  // Lane separators - endpoints baked once in `ensureCache`, AND all N
  // separators batched into a single path + single stroke. Each
  // separator shares strokeStyle + lineWidth so there's no need to
  // break them into individual stroke calls. Drops MAIN_LANE_COUNT-1
  // (= 3) stroke ops/frame to exactly 1; canvas drivers do less work
  // on a single multi-subpath stroke than on N independent strokes
  // because stroke setup (cap/join state, pixel-grid alignment) is
  // amortized across all subpaths.
  ctx.strokeStyle = palette.laneSeparator;
  ctx.lineWidth = 1;
  const sepBotY = cache.judgeY + 50;
  ctx.beginPath();
  for (let i = 0; i < cache.separatorTopX.length; i++) {
    ctx.moveTo(cache.separatorTopX[i], cache.topY);
    ctx.lineTo(cache.separatorBotX[i], sepBotY);
  }
  ctx.stroke();

  for (let b = 0; b < beatsToDraw; b++) {
    const t = firstBeat + b * beatLen;
    const progress = (t - songTime) / opts.leadTime;
    if (progress < 0 || progress > 1) continue;
    // Beat lines that just spawned at the top get the same quick alpha
    // ramp as notes - without it they pop into existence at full alpha
    // right at topY, which reads as a "twitch" on every measure as the
    // grid scrolls. Same SPAWN_FADE_PROGRESS constant as note + hold
    // fade-ins keeps every top-edge effect in sync.
    const beatAlpha =
      progress > SPAWN_FADE_PROGRESS
        ? (1 - progress) / (1 - SPAWN_FADE_PROGRESS)
        : 1;
    if (beatAlpha <= 0.02) continue;
    const y = cache.topY + (cache.judgeY - cache.topY) * (1 - progress);
    const xL = lerp(cache.topLeftX, cache.bottomLeftX, 1 - progress);
    const xR = lerp(cache.topRightX, cache.bottomRightX, 1 - progress);
    const isMeasure = Math.round((t - opts.offset) / beatLen) % 4 === 0;
    ctx.strokeStyle = isMeasure ? palette.measureLine : palette.beatLine;
    ctx.lineWidth = isMeasure ? 2 : 1;
    // save/restore only on the few frames a beat is in the fade zone -
    // most frames are fully opaque and skip the state shuffle entirely.
    const needsAlpha = beatAlpha < 1;
    if (needsAlpha) {
      ctx.save();
      ctx.globalAlpha = beatAlpha;
    }
    ctx.beginPath();
    ctx.moveTo(xL, y);
    ctx.lineTo(xR, y);
    ctx.stroke();
    if (needsAlpha) ctx.restore();
  }

  // Notes - draw hold trails first (behind), then heads.
  // Indexed loops over state.notes (instead of `for...of`) avoid the
  // per-frame Iterator object allocation. On dense charts (~3000 notes) the
  // hot path is called twice per frame, so this saves measurable GC.
  const notes = state.notes;
  const len = notes.length;

  // Advance the leading-edge cursor PAST any notes whose latest relevant
  // time (endT for holds, t for taps) is well beyond both fade windows.
  // Once advanced, those notes can't draw any pixels this frame or any
  // subsequent frame, so skipping them lets the per-frame cost scale with
  // the visible window instead of the song's elapsed length. Buffer (0.3s)
  // exceeds PAST_GRACE_S + JUDGED_FADE_S so we never elide a note that
  // could still contribute to a trailing fade.
  // Clamp on entry - a fresh GameState (new song / restart) resets `notes`
  // but the cursor lives on `rs`; bounds check protects against that race.
  if (rs.firstVisibleIdx > len) rs.firstVisibleIdx = 0;
  while (rs.firstVisibleIdx < len) {
    const n = notes[rs.firstVisibleIdx];
    const lastT = isHold(n) ? (n.endT as number) : n.t;
    if (songTime > lastT + 0.3) {
      rs.firstVisibleIdx++;
    } else {
      break;
    }
  }
  const startIdx = rs.firstVisibleIdx;
  for (let i = startIdx; i < len; i++) {
    const n = notes[i];
    if (!isHold(n)) continue;
    const headLook = n.t - songTime;
    const tailLook = (n.endT as number) - songTime;
    if (headLook > opts.leadTime + 0.05 && tailLook > opts.leadTime + 0.05) {
      if (headLook > opts.leadTime + 1) break;
      continue;
    }
    // Hold trail fade - same min() pattern as tap notes so the engine's
    // auto-miss flip doesn't pop the alpha back to 1 mid-fade.
    let trailAlpha = 1;
    if (tailLook < 0) {
      if (tailLook < -PAST_GRACE_S) continue;
      const t = -tailLook / PAST_GRACE_S;
      trailAlpha = (1 - t) * (1 - t);
    }
    if (n.tailJudged && n.tailJudgedAt !== undefined) {
      const since = songTime - n.tailJudgedAt;
      if (since >= JUDGED_FADE_S) continue;
      if (since >= 0) {
        const t = since / JUDGED_FADE_S;
        const judgedAlpha = (1 - t) * (1 - t);
        if (judgedAlpha < trailAlpha) trailAlpha = judgedAlpha;
      }
    }
    if (trailAlpha <= 0.01) continue;
    drawHoldTrail(ctx, n, songTime, opts, palette, trailAlpha, cache, perf);
  }
  // Reset anticipation each frame; we re-derive it from the upcoming notes.
  for (let i = 0; i < rs.laneAnticipation.length; i++) rs.laneAnticipation[i] = 0;
  for (let i = startIdx; i < len; i++) {
    const n = notes[i];
    const lookahead = n.t - songTime;
    if (lookahead > opts.leadTime + 0.05) {
      if (lookahead > opts.leadTime + 1) break;
      continue;
    }
    // Compute fade alpha as the MIN of the two pathways so the alpha
    // is monotonically decreasing - see JUDGED_FADE_S/PAST_GRACE_S
    // doc comment above for why this matters.
    let alpha = 1;
    if (lookahead < 0) {
      if (lookahead < -PAST_GRACE_S) continue;
      const t = -lookahead / PAST_GRACE_S; // 0..1
      alpha = (1 - t) * (1 - t); // ease-out: drops fast, trails into 0
    }
    if (n.judged && n.judgedAt !== undefined) {
      const since = songTime - n.judgedAt;
      if (since >= JUDGED_FADE_S) continue;
      if (since >= 0) {
        const t = since / JUDGED_FADE_S; // 0..1
        const judgedAlpha = (1 - t) * (1 - t);
        if (judgedAlpha < alpha) alpha = judgedAlpha;
      }
    }
    if (alpha <= 0.01) continue;
    // Anticipation only fires for upcoming (non-judged) notes - once the
    // note has passed or been hit, the gate shouldn't keep pulsing for it.
    if (
      !n.judged &&
      lookahead >= 0 &&
      lookahead < ANTICIPATION_WINDOW_S
    ) {
      const a = 1 - lookahead / ANTICIPATION_WINDOW_S;
      // Quadratic ramp so the gate ramps up near the line, not linearly.
      const v = a * a;
      if (v > rs.laneAnticipation[n.lane]) rs.laneAnticipation[n.lane] = v;
    }
    drawTapNote(ctx, n, lookahead, opts, palette, alpha, cache, perf, breath);
  }

  // Judgment line - subtle pulse on the beat AND on combo milestones.
  // In performance mode the pulsing shadow is the most repaint-heavy
  // strip on the canvas (it grows + shrinks every beat); we still draw
  // the line at the same alpha so timing is unambiguous, just without
  // the accent glow.
  ctx.save();
  ctx.strokeStyle = rgbaFromLut(
    cache.judgeRgba,
    clamp(palette.judgeBaseAlpha + beatPulse * 0.15 + ms * 0.2, 0, 1),
  );
  ctx.lineWidth = 2 + ms * 1;
  if (!perf) {
    ctx.shadowColor = rgbaFromLut(cache.accentRgba, 0.85);
    ctx.shadowBlur = 14 + beatPulse * 14 + ms * 22;
  }
  ctx.beginPath();
  ctx.moveTo(cache.bottomLeftX + 4, cache.judgeY);
  ctx.lineTo(cache.bottomRightX - 4, cache.judgeY);
  ctx.stroke();
  ctx.restore();

  // Per-lane judgment-line "kiss" - a tiny accent segment under each gate
  // that swells with the lane's most recent flash. Reads as the lane
  // "lighting up the floor" for half a beat after a hit. Skipped in
  // performance mode because (a) it overlaps the lane gate so the
  // visual cue isn't lost - the gate fill itself still flashes - and
  // (b) it draws with shadowBlur per-lane per-frame, which is expensive
  // on integrated GPUs.
  if (!perf) {
    for (let i = 0; i < MAIN_LANE_COUNT; i++) {
      const flash = rs.laneFlash[i] ?? 0;
      if (flash <= 0.05) continue;
      const x = cache.laneX[i];
      const w = 36 + flash * 28;
      ctx.save();
      ctx.strokeStyle = laneRgba(i, 0.35 + flash * 0.55);
      ctx.shadowColor = LANE_COLORS[i];
      ctx.shadowBlur = 14 + flash * 18;
      ctx.lineWidth = 3 + flash * 2;
      ctx.beginPath();
      ctx.moveTo(x - w / 2, cache.judgeY);
      ctx.lineTo(x + w / 2, cache.judgeY);
      ctx.stroke();
      ctx.restore();
    }
  }

  // Receptor dimensions are mode-independent (no yScale squash):
  // notes already match the receptor's 36 px screen height at the
  // judge line in both 2D and 3D (the note's FAR/near value ==
  // GATE_HEIGHT == NOTE_HEIGHT_2D), so squashing the receptor
  // would re-introduce the exact size mismatch the user reported.
  //
  // In 3D mode rect gates render as a TRAPEZOID that extends the
  // tap-note's perspective math across the judge line (the gate's
  // upper half uses the tap-note's near-edge width; the lower half
  // extrapolates past progress=0 toward the camera, which is
  // wider), so the incoming note and the resting receptor share
  // the same vanishing-point geometry pixel-for-pixel. Circles
  // stay circles in 3D - osu!-style receptor discs don't tilt into
  // ellipses, the perspective is carried by the surrounding rails.
  const perspective3D = opts.perspectiveMode === "3d";
  for (let i = 0; i < MAIN_LANE_COUNT; i++) {
    drawLaneGate(
      ctx,
      i,
      cache.laneX[i],
      cache.judgeY,
      // Same lane-proportional half-width every note / hold uses at
      // the judge line - receptor footprint locks to the landing
      // zone exactly (for rect mode in 2D and as the gate's AXIS
      // half-width in 3D, which is then perspective-corrected per
      // upper/lower half inside drawLaneGate). Circle mode uses
      // this value * CIRCLE_WIDTH_RATIO so disc and note diameters
      // match at the judge line.
      cache.laneHalfWidthBot * NOTE_WIDTH_RATIO,
      opts.laneHeld[i] ?? false,
      rs.laneFlash[i] ?? 0,
      state.isHolding(i),
      rs.laneAnticipation[i] ?? 0,
      palette,
      perf,
      opts.noteShape,
      cache,
      perspective3D,
    );
  }
}

// ---------------------------------------------------------------------------
function drawTapNote(
  ctx: CanvasRenderingContext2D,
  n: Note,
  lookahead: number,
  opts: RenderOptions,
  palette: ThemePalette,
  alpha: number,
  cache: RenderCache,
  perf: boolean,
  breath: number,
) {
  const perspective3D = opts.perspectiveMode === "3d";
  const isRect = opts.noteShape === "rect";

  const progress = lookahead / opts.leadTime;

  // Note on-screen vertical extent:
  //   - 3D: shrinks with distance (22 far → 36 near) so further-
  //     away tiles read as smaller. Near-end value equals
  //     `NOTE_HEIGHT_2D` so the note locks to the receptor's exact
  //     size at the judge line (osu convention).
  //   - 2D: constant 36 px. Flat playfield, constant tile size,
  //     matches receptor height pixel-for-pixel.
  const h = perspective3D
    ? lerp(NOTE_HEIGHT_3D_NEAR, NOTE_HEIGHT_3D_FAR, 1 - progress)
    : NOTE_HEIGHT_2D;

  const highwayH = cache.judgeY - cache.topY;

  const yCenter = cache.topY + highwayH * (1 - progress);

  // Per-progress X of the lane center at the note's position
  // (perspective handled by the cache's pre-lerped endpoints).
  const laneTopX = cache.laneXTop[n.lane];
  const laneBotX = cache.laneXBot[n.lane];

  const color = LANE_COLORS[n.lane];

  // Manual globalAlpha save/restore - shadowBlur must be explicitly
  // reset to 0 before we exit so downstream paths don't inherit it.
  const prevAlpha = ctx.globalAlpha;
  ctx.globalAlpha = alpha;

  if (isRect) {
    // --- RECTANGLE (brutalist) path -------------------------------
    //
    // 3D: renders as a true trapezoid derived from the highway's
    // vanishing-point geometry. 2D: the cache collapses top/bot lane
    // widths to the same value and the trapezoid degenerates to an
    // axis-aligned rectangle with zero extra branching.
    const yTop = yCenter - h * 0.5;
    const yBot = yCenter + h * 0.5;

    // Width-taper progress offset (3D tilt). A tile "lying flat
    // on the tilted fret plane" must have its corners on the same
    // rails that bound the lane at the tile's screen-y extent -
    // otherwise the note reads as tilted at a DIFFERENT angle
    // than the surrounding fret and visually lifts off the plane.
    //
    // Progress is a screen-space quantity (0 at the judge line,
    // 1 at the highway top, measured in the same px units as
    // `highwayH`), so the correct mapping is simply:
    //   yTop = y - h/2 -> pTop = progress + h/(2 * highwayH)
    //   yBot = y + h/2 -> pBot = progress - h/(2 * highwayH)
    // No PERSPECTIVE_Y_SCALE inversion (that would assume
    // progress is a plane-space quantity, which it isn't) and no
    // TILT_DEPTH_GAIN multiplier (that exaggerated the note's
    // taper ~2.36x past the lane's taper and made notes look
    // steeper than the fret they were supposed to lie on).
    //
    // In 2D `laneHalfWidthTop === laneHalfWidthBot` and
    // `laneXTop === laneXBot` after the ensureCache collapse, so
    // the same math degenerates cleanly to an axis-aligned rect.
    const dp = highwayH > 0 ? (h * 0.5) / highwayH : 0;
    // NOT clamped to [0, 1]. Earlier iterations did
    //   `Math.min(1, progress + dp)` / `Math.max(0, progress - dp)`
    // to keep the note's width inside the visible lane endpoints,
    // but that collapsed the trapezoid's taper whenever the note
    // was within `dp` of the highway top or the judge line - the
    // very spots where the perspective cue matters most. Letting
    // the edges extrapolate keeps the note on the same tilted
    // plane as its neighbors:
    //   * Top edge past 1: lane widths extrapolate NARROWER past
    //     the vanishing point - the note keeps its forward taper
    //     as it spawns. Note Y is already bounded by the highway
    //     rect, only the perspective width extrapolates.
    //   * Bottom edge past 0: lane widths extrapolate WIDER past
    //     the judge line - the note's near edge grows to match
    //     the receptor's lower half (which drawLaneGate
    //     extrapolates the same way), so the tap note and the
    //     resting gate share exactly one continuous trapezoid at
    //     impact instead of degenerating into mismatched widths.
    const pTopForX = progress + dp;
    const pBotForX = progress - dp;

    const xTopCenter = lerp(laneTopX, laneBotX, 1 - pTopForX);
    const xBotCenter = lerp(laneTopX, laneBotX, 1 - pBotForX);

    const halfWTop =
      lerp(cache.laneHalfWidthTop, cache.laneHalfWidthBot, 1 - pTopForX) *
      NOTE_WIDTH_RATIO;
    const halfWBot =
      lerp(cache.laneHalfWidthTop, cache.laneHalfWidthBot, 1 - pBotForX) *
      NOTE_WIDTH_RATIO;

    // Layered draw stack:
    //   1. Solid lane-colored trapezoid with a matching-color soft
    //      shadowBlur (quality only). Rectangular glow bleeding
    //      outward - brutalist-consistent, no circular halo.
    //   2. 1.25 px bright top-edge stripe (quality only) - single
    //      accent line, "light from above."
    //   3. 1 px darker bottom-edge stripe (both modes) - grounds
    //      the rectangle and gives the eye a crisp timing reference.
    //
    // Breath modulates SHADOW intensity only; solid fill never
    // dims (preserves the "fix the dull-dot" complaint fix).
    if (!perf) {
      const shadowAlpha = 0.4 + breath * 0.45;
      ctx.shadowColor = laneRgba(n.lane, shadowAlpha);
      ctx.shadowBlur = 6 + breath * 4;
    }

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(xTopCenter - halfWTop, yTop);
    ctx.lineTo(xTopCenter + halfWTop, yTop);
    ctx.lineTo(xBotCenter + halfWBot, yBot);
    ctx.lineTo(xBotCenter - halfWBot, yBot);
    ctx.closePath();
    ctx.fill();

    if (!perf) {
      ctx.shadowBlur = 0;
      ctx.strokeStyle = whiteShineRgba(0.5);
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.moveTo(xTopCenter - halfWTop, yTop);
      ctx.lineTo(xTopCenter + halfWTop, yTop);
      ctx.stroke();
    }

    ctx.strokeStyle = "rgba(0,0,0,0.4)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(xBotCenter - halfWBot, yBot);
    ctx.lineTo(xBotCenter + halfWBot, yBot);
    ctx.stroke();
  } else {
    // --- CIRCLE (classic osu!) path -------------------------------
    //
    // Disc sized off LANE WIDTH, not note height. The rect path
    // dominates the lane horizontally (~107 px at 2D judge line
    // on a 130 px lane), so sizing circles off the 36 px height
    // left them reading as tiny dots in a wide channel. The disc
    // scales with lane width via `NOTE_WIDTH_RATIO *
    // CIRCLE_WIDTH_RATIO` (see the CIRCLE_WIDTH_RATIO doc for the
    // osu-style gutter rationale). The hold ribbon in drawHoldTrail
    // picks up the same product so sustains match the head diameter.
    //
    // 3D perspective on the disc reduces to its Y foreshortening -
    // `halfWAt` already shrinks with distance (top of highway is
    // narrower than the judge line in 3D), so the radius scales
    // naturally without a separate squash pass. Horizontal
    // perspective is conveyed by the converging rails around it.
    const halfWAt =
      lerp(cache.laneHalfWidthTop, cache.laneHalfWidthBot, 1 - progress) *
      NOTE_WIDTH_RATIO;
    const r = halfWAt * CIRCLE_WIDTH_RATIO;
    const xCenter = lerp(laneTopX, laneBotX, 1 - progress);

    // Soft outer glow via shadowBlur on the disc fill. Same blur
    // amounts as the rect path so the two shapes feel equally
    // "emissive" when you toggle between them.
    if (!perf) {
      const shadowAlpha = 0.4 + breath * 0.45;
      ctx.shadowColor = laneRgba(n.lane, shadowAlpha);
      ctx.shadowBlur = 8 + breath * 5;
    }

    // Solid lane-colored disc.
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(xCenter, yCenter, r, 0, Math.PI * 2);
    ctx.fill();

    if (!perf) {
      ctx.shadowBlur = 0;

      // Inner highlight crescent - a single bright stripe on the
      // top of the disc, brutalist-restrained "light from above"
      // cue. Uses an offset smaller arc to avoid a full gradient
      // pass (which was measurably expensive in profiling).
      ctx.strokeStyle = whiteShineRgba(0.45);
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      // Top quadrant arc (from 200° to 340° in radians).
      ctx.arc(xCenter, yCenter, r * 0.78, Math.PI * 1.1, Math.PI * 1.9);
      ctx.stroke();
    }

    // Darker bottom rim shadow - same timing-cue role as the rect
    // path's bottom stripe (the eye reads the BOTTOM of the note
    // as the hit reference).
    ctx.strokeStyle = "rgba(0,0,0,0.4)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(xCenter, yCenter, r, Math.PI * 0.1, Math.PI * 0.9);
    ctx.stroke();
  }

  // Reset shadow so the NEXT draw call (popup text, particles,
  // the next note) doesn't inherit the blur. Cheap vs re-firing
  // a blur pass on unrelated geometry.
  if (!perf) {
    ctx.shadowBlur = 0;
  }

  ctx.globalAlpha = prevAlpha;
}

/**
 * Draw a hold-note sustain trail: a glowing ribbon stretching from the
 * head to the tail. While the player is actively holding the lane the
 * portion below the judgment line is "consumed" and the visible part
 * shortens as time advances toward `endT`.
 */
function drawHoldTrail(
  ctx: CanvasRenderingContext2D,
  n: Note,
  songTime: number,
  opts: RenderOptions,
  palette: ThemePalette,
  alphaMul: number,
  cache: RenderCache,
  perf: boolean,
) {
  const headLook = n.t - songTime;
  const tailLook = (n.endT as number) - songTime;

  const headProgress = clamp(headLook / opts.leadTime, -0.2, 1.05);
  const tailProgress = clamp(tailLook / opts.leadTime, -0.2, 1.05);

  // Convert lookahead progress (1=top, 0=judge line) to canvas y.
  // Read endpoints once into locals so the closure below doesn't have
  // to re-deref `cache` on each call.
  const topY = cache.topY;
  const judgeY = cache.judgeY;
  const yFromProgress = (p: number) => topY + (judgeY - topY) * (1 - p);

  // Trail visible only between top of highway and the judgment line.
  // Once the head crosses the judgment line, "freeze" the head at the line
  // (the player should be holding the lane gate, not chasing the head down).
  const visHead = Math.min(1, Math.max(0, headProgress));
  const visTail = Math.min(1, Math.max(0, tailProgress));
  if (visHead === 0 && visTail === 0) return; // entirely past judgment line
  if (visTail >= 1 && visHead >= 1) return;   // entirely off-screen up top

  const yHead = yFromProgress(visHead);
  const yTail = yFromProgress(visTail);

  // Per-lane endpoints baked once in `ensureCache`; only the visHead /
  // visTail interpolation runs per frame.
  const xHeadTop = cache.laneXTop[n.lane];
  const xHeadBot = cache.laneXBot[n.lane];
  const xHead = lerp(xHeadTop, xHeadBot, 1 - visHead);
  const xTail = lerp(xHeadTop, xHeadBot, 1 - visTail);

  // Width: matches the head note shape so the head / body / tail of
  // a hold all read as one continuous shape. In RECT mode the ribbon
  // uses the full lane-rect width (`NOTE_WIDTH_RATIO`); in CIRCLE
  // mode it narrows to the disc's diameter (`NOTE_WIDTH_RATIO *
  // CIRCLE_WIDTH_RATIO`) so the sustain ribbon is exactly as wide as
  // the head circle - otherwise the ribbon jutted out past the disc
  // on both sides and looked like two mismatched shapes glued
  // together (user-reported: "hold note for circles should have
  // same width as the circle").
  //
  // In 2D mode the `laneHalfWidthTop === laneHalfWidthBot` (ensureCache
  // collapse), so wHead === wTail === a constant width - the trail
  // renders as a plain vertical column. In 3D the ribbon tapers with
  // perspective (narrower at the far end, wider at the near end) so
  // it reads as one continuous shape laying on the tilted fret.
  const shapeWidthRatio =
    opts.noteShape === "circle"
      ? NOTE_WIDTH_RATIO * CIRCLE_WIDTH_RATIO
      : NOTE_WIDTH_RATIO;
  const halfWHead =
    lerp(cache.laneHalfWidthTop, cache.laneHalfWidthBot, 1 - visHead) *
    shapeWidthRatio;
  const halfWTail =
    lerp(cache.laneHalfWidthTop, cache.laneHalfWidthBot, 1 - visTail) *
    shapeWidthRatio;
  const wHead = halfWHead * 2;
  const wTail = halfWTail * 2;

  const color = LANE_COLORS[n.lane];
  const consumed = n.holding === true;
  const alpha = consumed ? 0.85 : n.tailJudged === "miss" ? 0.18 : 0.55;

  // Manual globalAlpha save/restore. Previously `ctx.save()/restore()`,
  // dropped because the only state we leak on the way out is fillStyle/
  // strokeStyle/lineWidth - every downstream path overwrites all three
  // on entry. shadowBlur is explicitly reset to 0 below before exit
  // so subsequent paths aren't accidentally shadowed. Saves 2 canvas
  // state-stack ops per visible hold per frame.
  const prevAlpha = ctx.globalAlpha;
  ctx.globalAlpha = alphaMul;
  ctx.fillStyle = laneRgba(n.lane, alpha);
  // Same "near the line" gating as drawTapNote - a hold trail's shadow
  // is the most expensive part of its draw, but visually only matters
  // when the head is close to the judge line OR the note is being
  // actively sustained (consumed). Far-up trails skip the blur entirely.
  // Performance mode drops it everywhere; the colored ribbon body is
  // still drawn so the sustain remains obvious.
  const trailNearLine = !perf && (visHead < 0.55 || visTail < 0.55);
  if (!perf && (consumed || trailNearLine)) {
    ctx.shadowColor = color;
    ctx.shadowBlur = (consumed ? 22 : 10) * alphaMul;
  }
  // Trapezoid between (xTail±wTail/2, yTail) and (xHead±wHead/2, yHead).
  ctx.beginPath();
  ctx.moveTo(xTail - wTail / 2, yTail);
  ctx.lineTo(xTail + wTail / 2, yTail);
  ctx.lineTo(xHead + wHead / 2, yHead);
  ctx.lineTo(xHead - wHead / 2, yHead);
  ctx.closePath();
  ctx.fill();

  // Thin bright outline so the trail reads even on dark bg.
  ctx.shadowBlur = 0;
  ctx.strokeStyle = laneRgba(n.lane, consumed ? 1 : 0.7);
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.globalAlpha = prevAlpha;

  // No tail cap: the outlined ribbon body already closes cleanly
  // at (xTail±wTail/2, yTail), so the release point is visible
  // from the ribbon's top edge alone. Matches osu!mania 4K and
  // DDR-style conventions where the hold body just ENDS - a
  // separate bright "cap" at the tail reads as visual noise
  // (players already know to release when the ribbon's top edge
  // reaches the receptor), and earlier iterations filled the cap
  // with a dark tone that read as a rendering glitch. Dropping
  // the cap also saves one shadowBlur + two strokes per visible
  // hold per frame in quality mode, measurable on dense charts.
}

// ---------------------------------------------------------------------------
function drawLaneGate(
  ctx: CanvasRenderingContext2D,
  lane: number,
  x: number,
  y: number,
  /**
   * Receptor half-width in canvas px for RECT mode. Same formula
   * as a note's half-width at the judge line:
   *   `cache.laneHalfWidthBot * NOTE_WIDTH_RATIO`
   * Threaded from the call site so the rectangular receptor locks
   * to the note's landing footprint. Ignored in CIRCLE mode, which
   * uses `GATE_RADIUS` so the disc matches the note diameter
   * instead of the lane width.
   */
  halfW: number,
  held: boolean,
  flash: number,
  holding: boolean,
  anticipation: number,
  palette: ThemePalette,
  perf: boolean,
  /**
   * Note / receptor shape. `"rect"` renders the brutalist slot;
   * `"circle"` renders a classic disc receptor. Shapes share state
   * (fill / border / flash / shine) so toggling mid-run keeps the
   * visual language consistent.
   */
  shape: NoteShapeMode,
  /**
   * Render cache, used in RECT mode to derive the trapezoid
   * corners from the highway's per-progress lane endpoints +
   * half-widths. Only read when `perspective3D` is true; in 2D the
   * cache's top/bot endpoints collapse to the same value so the
   * same math would degenerate to a rectangle anyway (we just
   * short-circuit that path with a cheap flag check).
   */
  cache: RenderCache,
  /**
   * True when the user is playing in 3D perspective mode. Gate
   * rect geometry mirrors the tap-note trapezoid at progress=0 so
   * the incoming note and the resting receptor share the exact
   * same vanishing-point tapering; 2D mode skips the trapezoid
   * math entirely and draws an axis-aligned rect.
   */
  perspective3D: boolean,
) {
  const color = LANE_COLORS[lane];

  ctx.save();

  // Shared inner-fill state: lane color on hold / flash, fallback
  // to the dark "empty slot" palette tone otherwise. Drawn first
  // in every shape so the next pass (border with shadowBlur) paints
  // its glow on top without being clipped by the inner fill.
  const fillAlpha = Math.max(
    holding ? 0.95 : held ? 0.85 : 0,
    flash,
  );
  const innerFillStyle =
    fillAlpha > 0 ? laneRgba(lane, fillAlpha) : palette.gateInner;

  // Border glow intensity (shared across shapes). Blur encodes
  // state:
  //   - idle:          2 px (barely-there brand presence)
  //   - anticipation:  ramps to +10 px as the note approaches
  //   - press flash:   adds up to +18 px on a fresh hit
  //   - holding:       adds +14 px for the duration of the sustain
  // Perf mode drops the shadow to 0; the colored border + the white
  // brightness-pop stroke below still communicate every state
  // change with zero shadow-pass cost.
  const borderBlur = !perf
    ? 2 + anticipation * 10 + flash * 18 + (holding ? 14 : held ? 6 : 0)
    : 0;

  if (shape === "rect") {
    // --- RECT receptor --------------------------------------------
    //
    // Tile centered at (x, y) with height `GATE_HEIGHT`. NO yScale
    // squash anymore - the note's 3D taper comes from its width
    // not its height, so the receptor doesn't need a squashed
    // height to match. The note's NEAR/judge-line size already
    // equals GATE_HEIGHT pixel-for-pixel.
    //
    // In 3D mode the gate renders as a TRAPEZOID using the exact
    // same `planeH` / `dp` math drawTapNote uses at progress=0,
    // but with the bottom half extrapolated past the judge line
    // (pBot = -dp, NOT clamped to 0) - the gate straddles the
    // judge line and its lower half sits "past" the fret's near
    // edge, so its width must extrapolate wider than laneHalfWidthBot
    // to stay on the same tilted plane as the incoming note.
    // This makes the tap note at progress=0 and the resting
    // receptor align pixel-perfect: both share identical top + bot
    // edge widths.
    //
    // In 2D mode `perspective3D` is false and we fast-path a plain
    // axis-aligned rect - the trapezoid math would degenerate to
    // the same result anyway (laneHalfWidthTop == laneHalfWidthBot,
    // laneXTop == laneXBot when the cache collapses), but the
    // short-circuit saves 4 lerps + a shadowed path stroke per
    // gate per frame on the perf-mode fast path.
    const halfH = GATE_HEIGHT * 0.5;
    const yTop = y - halfH;
    const yBot = y + halfH;

    let xTopCenter: number;
    let xBotCenter: number;
    let halfWTop: number;
    let halfWBot: number;
    if (perspective3D) {
      // Screen-space mapping: the gate's upper half occupies
      // `halfH` px above the judge line, so pTop = +halfH /
      // highwayH. Lower half mirrors it past the judge line
      // (pBot = -halfH / highwayH, extrapolated wider than the
      // lane's near-end rails). Matches drawTapNote's dp exactly
      // at progress=0 so an incoming note and the resting
      // receptor share the same trapezoid pixel-for-pixel at
      // impact - no kink at the judge line.
      const highwayH = cache.judgeY - cache.topY;
      const dp = highwayH > 0 ? (GATE_HEIGHT * 0.5) / highwayH : 0;
      const pTop = dp;   // above judge line, inside visible highway
      const pBot = -dp;  // below judge line, extrapolated past fret
      xTopCenter = lerp(cache.laneXTop[lane], cache.laneXBot[lane], 1 - pTop);
      xBotCenter = lerp(cache.laneXTop[lane], cache.laneXBot[lane], 1 - pBot);
      halfWTop =
        lerp(cache.laneHalfWidthTop, cache.laneHalfWidthBot, 1 - pTop) *
        NOTE_WIDTH_RATIO;
      halfWBot =
        lerp(cache.laneHalfWidthTop, cache.laneHalfWidthBot, 1 - pBot) *
        NOTE_WIDTH_RATIO;
    } else {
      xTopCenter = x;
      xBotCenter = x;
      halfWTop = halfW;
      halfWBot = halfW;
    }

    // Build the trapezoid path once, reuse for fill + border +
    // flash strokes. `ctx.fill()` / `ctx.stroke()` both operate on
    // the current path, so we only pay the moveTo/lineTo cost once
    // per gate per frame (vs. 3 axis-aligned rect calls before).
    ctx.beginPath();
    ctx.moveTo(xTopCenter - halfWTop, yTop);
    ctx.lineTo(xTopCenter + halfWTop, yTop);
    ctx.lineTo(xBotCenter + halfWBot, yBot);
    ctx.lineTo(xBotCenter - halfWBot, yBot);
    ctx.closePath();

    ctx.fillStyle = innerFillStyle;
    ctx.fill();

    if (!perf) {
      ctx.shadowColor = color;
      ctx.shadowBlur = borderBlur;
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = GATE_BORDER;
    ctx.stroke();

    // Reset shadow so subsequent overlays + text don't double-blur
    // (shadowBlur on text is expensive AND visually wrong here).
    ctx.shadowBlur = 0;

    if (flash > 0.05) {
      ctx.strokeStyle = whiteShineRgba(0.55 * flash);
      ctx.lineWidth = GATE_BORDER;
      ctx.stroke();
    }
  } else {
    // --- CIRCLE receptor ------------------------------------------
    //
    // Disc centered at (x, y) with radius = `halfW * CIRCLE_WIDTH_RATIO`
    // (same formula the tap-note uses at the judge line), so note
    // and receptor LOCK to the same diameter on landing. Matches
    // osu!mania convention: the circle receptor is literally the
    // same size as the note that's about to land on it. Scales
    // automatically with lane width when the highway resizes.
    const r = halfW * CIRCLE_WIDTH_RATIO;

    ctx.fillStyle = innerFillStyle;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();

    if (!perf) {
      ctx.shadowColor = color;
      ctx.shadowBlur = borderBlur;
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = GATE_BORDER;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();

    ctx.shadowBlur = 0;

    if (flash > 0.05) {
      ctx.strokeStyle = whiteShineRgba(0.55 * flash);
      ctx.lineWidth = GATE_BORDER;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // Label + arrow positioning. Tuned for the shared 36 px tile
  // height so the letter + arrow stack (22 px + 9 px + gap = ~33 px)
  // fits with a ~1.5 px breathing margin on each side. Shared
  // across shapes because both rect and circle are centered on
  // (x, y) and have the same vertical extent.
  const LETTER_DY = -6;
  const ARROW_DY = 7;
  const ARROW_SIZE = 9;

  // Press shine intensity - strongest on an active hold sustain, slightly
  // softer on a normal keypress, fades out alongside the lane flash.
  const shine = holding ? 1 : held ? 0.85 : flash * 0.6;

  ctx.fillStyle = color;
  if (!perf && shine > 0.05) {
    // White-on-color glow halo: blooms the glyph silhouette without
    // washing out the lane color underneath. The shadow stacks under the
    // fill so the letter itself stays crisp.
    // Quantize shine to 32 buckets so we hit one of N pre-built rgba
    // strings in `WHITE_SHINE_RGBA` instead of allocating + parsing a
    // brand-new "rgba(255,255,255,0.123)" every frame per lane.
    ctx.shadowColor = whiteShineRgba(0.55 * shine);
    ctx.shadowBlur = 14 * shine;
  } else {
    ctx.shadowBlur = 0;
  }
  // 800 (ExtraBold) is the heaviest weight loaded for JetBrains Mono - see
  // app/layout.tsx. Asking for 900 here would silently fall back to 700
  // (the next loaded weight) and make the letter look the same as
  // font-bold. 22 px is the sweet spot for the new 36 px receptor:
  // ExtraBold caps at 22 px ≈ 15 px cap height, which leaves the
  // chevron room to sit legibly beneath with a ~1.5 px inset from
  // the receptor's inner edge.
  ctx.font = "800 22px var(--font-mono), ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(LANE_LABEL[lane], x, y + LETTER_DY);

  // Brutalist arrow indicator under the letter - drawn as a real canvas
  // path (not a font glyph) so it's pixel-identical to the SVG arrows used
  // in the rest of the UI. Slightly dimmer than the letter so the lane
  // identity reads "letter-first". Brightens on press for the same shine.
  ctx.shadowBlur = 0;
  const arrowAlpha = clamp(0.78 + shine * 0.22, 0, 1);
  drawArrow(
    ctx,
    LANE_ARROW_DIR[lane] ?? "down",
    x,
    y + ARROW_DY,
    ARROW_SIZE,
    laneRgba(lane, arrowAlpha),
    // Pass shine=0 in perf mode so drawArrow takes the no-shadow
    // fast path. Without this gate the chevron would re-arm a
    // 8 * shine blur on every key-press / sustain frame even though
    // the rest of the gate already dropped its glows. The arrow
    // strokes themselves are unaffected (stroke alpha is derived
    // from `arrowAlpha` above, not `shine`).
    perf ? 0 : shine,
  );
  ctx.restore();
}

// Draws a brutalist arrow centered at (cx, cy) using straight strokes with
// square caps + miter joins. `size` is the total bounding box (the shaft
// runs the full size; the chevron sits inside one ~third of it).
function drawArrow(
  ctx: CanvasRenderingContext2D,
  dir: ArrowDir,
  cx: number,
  cy: number,
  size: number,
  strokeStyle: string,
  shine: number = 0,
) {
  const half = size / 2;
  const head = Math.max(3, Math.round(size * 0.42));

  ctx.save();
  ctx.strokeStyle = strokeStyle;
  // 0.21 ratio keeps the chevron visually weighted to match a 900-weight
  // letter sitting above it (smaller than 0.21 looks flimsy, larger than
  // 0.24 turns the chevron into a solid blob at small sizes).
  ctx.lineWidth = Math.max(2, size * 0.21);
  ctx.lineCap = "square";
  ctx.lineJoin = "miter";
  ctx.miterLimit = 4;
  if (shine > 0.05) {
    ctx.shadowColor = whiteShineRgba(0.45 * shine);
    ctx.shadowBlur = 8 * shine;
  } else {
    ctx.shadowBlur = 0;
  }

  ctx.beginPath();
  if (dir === "left") {
    ctx.moveTo(cx + half, cy);
    ctx.lineTo(cx - half, cy);
    ctx.moveTo(cx - half + head, cy - head);
    ctx.lineTo(cx - half, cy);
    ctx.lineTo(cx - half + head, cy + head);
  } else if (dir === "right") {
    ctx.moveTo(cx - half, cy);
    ctx.lineTo(cx + half, cy);
    ctx.moveTo(cx + half - head, cy - head);
    ctx.lineTo(cx + half, cy);
    ctx.lineTo(cx + half - head, cy + head);
  } else if (dir === "up") {
    ctx.moveTo(cx, cy + half);
    ctx.lineTo(cx, cy - half);
    ctx.moveTo(cx - head, cy - half + head);
    ctx.lineTo(cx, cy - half);
    ctx.lineTo(cx + head, cy - half + head);
  } else {
    ctx.moveTo(cx, cy - half);
    ctx.lineTo(cx, cy + half);
    ctx.moveTo(cx - head, cy + half - head);
    ctx.lineTo(cx, cy + half);
    ctx.lineTo(cx + head, cy + half - head);
  }
  ctx.stroke();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Judgment popup constants - keep ALL string literals out of the hot loop.
// Pre-built LUTs / font cache / labels save 4 string allocations + a
// `parseInt` × 3 + a `toFixed` per popup per frame. With 4 lanes firing
// once per beat that's ~100 strings/sec eliminated, enough to keep this
// path completely off the GC.
// ---------------------------------------------------------------------------
const JUDGE_PALETTE: Record<JudgmentEvent["judgment"], { rgba: string[]; rgb: string }> = {
  perfect: { rgba: makeRgbaLut({ r: 61, g: 169, b: 255 }), rgb: "rgb(61,169,255)" },
  great:   { rgba: makeRgbaLut({ r: 61, g: 255, b: 138 }), rgb: "rgb(61,255,138)" },
  good:    { rgba: makeRgbaLut({ r: 255, g: 210, b: 63 }), rgb: "rgb(255,210,63)" },
  miss:    { rgba: makeRgbaLut({ r: 255, g: 59, b: 107 }), rgb: "rgb(255,59,107)" },
};

const JUDGE_LABELS: Record<JudgmentEvent["judgment"], string> = {
  perfect: "PERFECT",
  great:   "GREAT",
  good:    "GOOD",
  miss:    "MISS",
};

const JUDGE_LABELS_HOLD: Record<JudgmentEvent["judgment"], string> = {
  perfect: "PERFECT·HOLD",
  great:   "GREAT·HOLD",
  good:    "GOOD·HOLD",
  miss:    "MISS·HOLD",
};

// 32-bucket font cache: popup font size animates over a ~0.6s window so
// we get away with 32 buckets between 15.5px ("just spawned, scaled to
// 0.86") and 22px ("full punchy bump") without any visible step. One
// font string per bucket + one for the static "MISS" size.
const POPUP_FONT_BUCKETS = 32;
const POPUP_FONT_MIN = 15;
const POPUP_FONT_MAX = 22;
const POPUP_FONT_LUT: string[] = (() => {
  const out = new Array<string>(POPUP_FONT_BUCKETS);
  for (let i = 0; i < POPUP_FONT_BUCKETS; i++) {
    const px = POPUP_FONT_MIN + (POPUP_FONT_MAX - POPUP_FONT_MIN) * (i / (POPUP_FONT_BUCKETS - 1));
    out[i] = `800 ${px.toFixed(1)}px var(--font-display), system-ui, sans-serif`;
  }
  return out;
})();

function popupFont(px: number): string {
  let i = Math.round(((px - POPUP_FONT_MIN) / (POPUP_FONT_MAX - POPUP_FONT_MIN)) * (POPUP_FONT_BUCKETS - 1));
  if (i < 0) i = 0;
  else if (i > POPUP_FONT_BUCKETS - 1) i = POPUP_FONT_BUCKETS - 1;
  return POPUP_FONT_LUT[i];
}

function drawJudgmentPopups(
  ctx: CanvasRenderingContext2D,
  events: JudgmentEvent[],
  songTime: number,
  y: number,
  cache: RenderCache,
  perf: boolean,
) {
  ctx.save();
  ctx.textAlign = "center";
  // Indexed loop (not for...of) per the project's hot-path convention -
  // every frame allocates one fewer Iterator object. Events array is
  // capped at 32 by the engine, but this runs every frame for the entire
  // session so the savings add up.
  const evLen = events.length;
  for (let i = 0; i < evLen; i++) {
    const ev = events[i];
    const age = songTime - ev.at;
    if (age < 0 || age > 0.6) continue;
    const t = age / 0.6;
    // Cubic-out lift: fast at the start, settles at the top - reads as a
    // satisfying "pop" instead of a constant linear drift.
    const liftEase = 1 - Math.pow(1 - t, 3);
    const yOff = -liftEase * 56;
    // Alpha eases out late so the label stays legible most of its life.
    const alpha = 1 - Math.pow(t, 2.2);
    // Brief overshoot scale on perfect/great so the label feels punched
    // out into the world rather than slid in.
    const punchy = ev.judgment === "perfect" || ev.judgment === "great";
    const scale = punchy
      ? 0.86 + (1 - Math.pow(1 - Math.min(1, t * 3), 2)) * 0.22
      : 1;
    ctx.font = popupFont(18 * scale);
    const tableLabels = ev.tail ? JUDGE_LABELS_HOLD : JUDGE_LABELS;
    const label = tableLabels[ev.judgment];
    const palette = JUDGE_PALETTE[ev.judgment];
    const x = cache.laneX[ev.lane] ?? cache.cx;
    ctx.fillStyle = rgbaFromLut(palette.rgba, alpha);
    if (!perf) {
      ctx.shadowColor = palette.rgb;
      ctx.shadowBlur = 12 * alpha;
    }
    ctx.fillText(label, x, y + yOff);
  }
  ctx.shadowBlur = 0;
  ctx.restore();
}

// ---------------------------------------------------------------------------
/**
 * Big combo number rendered straight on the canvas above the judge line.
 * Only shows once the combo passes 10 - below that the HUD card already
 * carries the information and a giant "5" on the highway looks silly.
 *
 * Sized to swell on milestones, fade slightly on the off-beat. Cheap: a
 * single fillText call per frame.
 */
// Per-integer-pixel font caches for the canvas combo. `size` ranges
// roughly 56..98 (combo) and 13..22 (label sub-text) so we round to int
// pixels and key into a tiny LUT instead of building a fresh
// `"800 NNpx ..."` string every frame the combo is on screen. Display
// + mono have separate caches because they reference different CSS
// variables.
const COMBO_FONT_DISPLAY: Record<number, string> = {};
const COMBO_FONT_MONO: Record<number, string> = {};
function comboFontDisplay(px: number): string {
  const k = px | 0;
  let s = COMBO_FONT_DISPLAY[k];
  if (!s) {
    s = `800 ${k}px var(--font-display), system-ui, sans-serif`;
    COMBO_FONT_DISPLAY[k] = s;
  }
  return s;
}
function comboFontMono(px: number): string {
  const k = px | 0;
  let s = COMBO_FONT_MONO[k];
  if (!s) {
    s = `800 ${k}px var(--font-mono), ui-monospace, monospace`;
    COMBO_FONT_MONO[k] = s;
  }
  return s;
}

// Cache the most recently rendered combo digit string so we don't
// allocate `String(combo)` every frame the combo number is steady.
// (A combo can hold for tens of seconds during a perfect run; without
// this we'd burn ~60 small string allocations / sec for nothing.)
let comboDigitsCache = -1;
let comboDigitsStr = "";

function drawCanvasCombo(
  ctx: CanvasRenderingContext2D,
  rs: RenderState,
  cache: RenderCache,
  palette: ThemePalette,
  perf: boolean,
): void {
  if (rs.combo < 10) return;
  const ms = rs.milestone?.strength ?? 0;
  // Base size scales softly with combo, ceiling at 100 so 999 doesn't
  // explode across the screen. Tier + milestone both feed visual weight,
  // giving the player a clear "you're cooking" moment as they string hits.
  const tier = Math.min(1, rs.combo / 100);
  const size = 56 + tier * 28 + ms * 14;
  const alpha = clamp(0.28 + tier * 0.32 + ms * 0.45, 0, 0.95);
  const y = cache.judgeY - 130;
  if (rs.combo !== comboDigitsCache) {
    comboDigitsCache = rs.combo;
    comboDigitsStr = String(rs.combo);
  }
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.font = comboFontDisplay(size);
  ctx.fillStyle = rgbaFromLut(cache.accentRgba, alpha);
  if (!perf) {
    ctx.shadowColor = rgbaFromLut(cache.accentRgba, 0.6);
    ctx.shadowBlur = 18 + ms * 28;
  }
  ctx.fillText(comboDigitsStr, cache.cx, y);
  ctx.shadowBlur = 0;
  ctx.font = comboFontMono(size * 0.22);
  ctx.fillStyle = rgbaFromLut(cache.accentRgba, clamp(alpha * 0.85, 0, 1));
  ctx.fillText("COMBO", cache.cx, y + 14);
  ctx.restore();
}

// ---------------------------------------------------------------------------
/**
 * Brief tinted vignette on milestone - a screen-edge accent flash that
 * fades over ~700ms. We re-use the cached vignette gradient stop pattern,
 * but with the brand accent instead of the dark stop, and we only paint
 * it when a milestone is active.
 */
function drawMilestoneVignette(
  ctx: CanvasRenderingContext2D,
  rs: RenderState,
  W: number,
  H: number,
  cache: RenderCache,
): void {
  const m = rs.milestone;
  if (!m || m.strength <= 0) return;
  // Curve: peak quickly then trail off - feels like a flash, not a pulse.
  // `lighter` blend lets the accent edge punch *through* the highway
  // colors instead of muddying them, which is what gives the milestone
  // its characteristic "screen reacts" arcade pop.
  // Uses the cached `cache.milestoneVignette` (baked at unit alpha for
  // the accent) - globalAlpha scales the flash without rebuilding the
  // gradient every frame.
  const k = clamp(m.strength, 0, 1);
  const peakAlpha = 0.32 * k * k;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.globalAlpha = peakAlpha;
  ctx.fillStyle = cache.milestoneVignette;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Shockwave rings - drawn between the highway pass and the particles. Use
// `lighter` blend so overlapping waves stack into a brighter peak rather
// than canceling each other out, matching osu!mania's hit feedback feel.
// ---------------------------------------------------------------------------
function updateAndDrawShockwaves(
  ctx: CanvasRenderingContext2D,
  rs: RenderState,
  dt: number,
  palette: ThemePalette,
  opts: RenderOptions,
): void {
  const sw = rs.shockwaves;
  if (sw.length === 0) return;
  // Shockwaves burst FROM the fret button plane, so they share the
  // gate's perspective squash in 3D mode (rings expand across the
  // tilted fret, not straight up into screen space). Circles in 2D.
  const yScale = opts.perspectiveMode === "3d" ? PERSPECTIVE_Y_SCALE : 1;
  let write = 0;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (let read = 0; read < sw.length; read++) {
    const s = sw[read];
    s.life -= dt;
    if (s.life <= 0) continue;
    const t = 1 - s.life / s.maxLife;            // 0 → 1
    const ease = 1 - Math.pow(1 - t, 2.2);       // ease-out radius
    const radius = 22 + ease * (s.intense ? 88 : 64);
    const alpha = (1 - t) * (s.intense ? 0.85 : 0.65);
    ctx.lineWidth = (s.intense ? 3 : 2) * (1 - t * 0.6);
    ctx.strokeStyle = laneRgba(s.laneIdx, alpha);
    ctx.shadowColor = LANE_COLORS[s.laneIdx];
    ctx.shadowBlur = (s.intense ? 26 : 14) * (1 - t);
    ctx.beginPath();
    ctx.ellipse(s.x, s.y, radius, radius * yScale, 0, 0, TAU);
    ctx.stroke();
    if (s.intense && t < 0.4) {
      // White core for the first ~180ms of perfect hits - the splash that
      // your eye reads as "yes that was clean".
      ctx.strokeStyle = whiteShineRgba(0.55 * (1 - t * 2.5));
      ctx.lineWidth = 1.5;
      ctx.shadowBlur = 0;
      ctx.beginPath();
      const coreR = radius * 0.55;
      ctx.ellipse(s.x, s.y, coreR, coreR * yScale, 0, 0, TAU);
      ctx.stroke();
    }
    if (write !== read) sw[write] = s;
    write++;
  }
  ctx.restore();
  sw.length = write;
  // Reference palette param so it stays in scope for future use (mute warn)
  void palette;
}

function drawBeatDot(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  pulse: number,
  isDownbeat: boolean,
  palette: ThemePalette,
  cache: RenderCache,
  perf: boolean,
) {
  ctx.save();
  // Downbeats use the brand accent (theme-shifted), off-beats use the
  // theme's idle dot color. We re-use the prebuilt `accentRgba` /
  // `beatDotIdleRgba` LUTs (baked once per resize / theme swap) for the
  // fill alpha, so this hot path no longer concatenates an
  // `rgba(...)` string + a `rgb(...)` shadowColor 60 times a second.
  const lut = isDownbeat ? cache.accentRgba : cache.beatDotIdleRgba;
  const r = 5 + pulse * 5;
  if (!perf) {
    // Solid (alpha 1) entry of the same LUT - the shadow only cares
    // about the RGB channels.
    ctx.shadowColor = rgbaFromLut(lut, 1);
    ctx.shadowBlur = 8 + pulse * 16;
  }
  ctx.fillStyle = rgbaFromLut(lut, 0.35 + pulse * 0.65);
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Particle system - small, no shadow blur, capped by PARTICLE_BUDGET.
// What it does: on a successful tap the renderer spawns ~16 particles at
// the lane gate. They fly upward with random spread, fade, and shrink.
// Cheap to draw (filled circles, no shadow), but huge perceived polish gain.
// ---------------------------------------------------------------------------

function drainHits(rs: RenderState, cache: RenderCache): void {
  const hits = rs.pendingHits;
  const n = hits.length;
  if (n === 0) return;
  // Indexed loop (not for...of) - same hot-path convention used by the
  // popup loop. Saves one Iterator allocation per frame at the price of
  // one local variable.
  for (let idx = 0; idx < n; idx++) {
    const h = hits[idx];
    if (h.judgment === "miss") continue; // misses get the "duck" sfx, no sparkles
    const x = cache.laneX[h.lane];
    const y = cache.judgeY;
    const count =
      h.judgment === "perfect" ? 18 : h.judgment === "great" ? 12 : 6;
    const speed =
      h.judgment === "perfect" ? 380 : h.judgment === "great" ? 280 : 180;
    spawnBurst(rs, x, y, h.lane, count, speed, h.tail === true);

    // Shockwave ring on perfect/great. Hold tails get one too but smaller.
    if (h.judgment === "perfect" || h.judgment === "great") {
      if (rs.shockwaves.length < SHOCKWAVE_BUDGET) {
        const life = h.judgment === "perfect" ? 0.45 : 0.32;
        rs.shockwaves.push({
          x,
          y,
          laneIdx: h.lane,
          life,
          maxLife: life,
          intense: h.judgment === "perfect",
        });
      }
    }
  }
  rs.pendingHits.length = 0;
}

function spawnBurst(
  rs: RenderState,
  x: number,
  y: number,
  laneIdx: number,
  count: number,
  speed: number,
  tail: boolean,
): void {
  const ps = rs.particles;
  for (let i = 0; i < count; i++) {
    if (ps.length >= PARTICLE_BUDGET) break;
    // Cone emit: mostly upward but with a 90° spread.
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI;
    const v = speed * (0.5 + Math.random() * 0.7);
    const life = 0.35 + Math.random() * 0.35;
    ps.push({
      x,
      y: y - 4,
      vx: Math.cos(angle) * v,
      vy: Math.sin(angle) * v,
      life,
      maxLife: life,
      size: tail ? 1.5 + Math.random() * 1.5 : 2 + Math.random() * 2.5,
      laneIdx,
    });
  }
}

const GRAVITY = 480; // px/sec^2 - gentle pull so particles arc

function updateAndDrawParticles(
  ctx: CanvasRenderingContext2D,
  rs: RenderState,
  dt: number,
): void {
  const ps = rs.particles;
  if (ps.length === 0) return;

  // In-place compaction: update every particle, drop dead ones by writing
  // surviving ones forward. Avoids per-frame allocation.
  let write = 0;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (let read = 0; read < ps.length; read++) {
    const p = ps[read];
    p.life -= dt;
    if (p.life <= 0) continue;
    p.vy += GRAVITY * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    const a = p.life / p.maxLife;
    // Hot path: use the pre-computed lane×alpha lookup so we don't
    // allocate a fresh `rgba()` string every particle every frame.
    // With PARTICLE_BUDGET=200 this kills ~12k string allocs/sec.
    ctx.fillStyle = laneRgba(p.laneIdx, a * a);
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * (0.4 + a * 0.6), 0, TAU);
    ctx.fill();
    if (write !== read) ps[write] = p;
    write++;
  }
  ctx.restore();
  ps.length = write;
}

// ---------------------------------------------------------------------------
function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

// NaN-safe: a plain `v < lo ? lo : v > hi ? hi : v` returns `NaN` for
// `NaN` input (both comparisons evaluate false). That's the wrong
// behavior for downstream consumers - a NaN ratio handed to e.g.
// `addColorStop` throws "non-finite double" and aborts the entire
// frame paint. We collapse non-finite inputs to `lo` so the gradient
// stays valid even when an upstream divide-by-zero leaks through.
function clamp(v: number, lo: number, hi: number) {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Convert "#rrggbb" to "rgba(r,g,b,a)". Slow path - three parseInts each call.
 * Prefer the pre-parsed `rgba(LANE_RGB[i], a)` form on per-frame hot paths.
 * Kept here for one-off colors (popup grades, beat dot variants).
 */
function withAlpha(hex: string, a: number) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

