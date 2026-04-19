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

export interface RenderOptions {
  /** Seconds of look-ahead — note travels from top to judgment line in this time. */
  leadTime: number;
  /** Pulses each lane gate when its key is held. Indexed by lane (0 .. TOTAL_LANES-1). */
  laneHeld: boolean[];
  /** Judgment line vertical position as fraction of canvas height (0..1). */
  judgeLineY: number;
  /** BPM of the current song (for beat-line drawing & beat pulse). */
  bpm: number;
  /** Song offset (seconds) for beat-line alignment. */
  offset: number;
  /** Active UI theme — drives the canvas color palette. */
  theme: ThemeName;
}

/**
 * All canvas colors that change with the active theme. Resolved once per
 * frame from `opts.theme` and threaded into every draw helper. Anything
 * NOT in here (lane colors, judgment popup grades) is intentionally
 * theme-agnostic — those use a fixed brand palette so a perfect-tap
 * always reads as "blue green great" regardless of UI mode.
 */
export interface ThemePalette {
  /** Stable id used to invalidate the gradient cache on theme swap. */
  id: ThemeName;
  /**
   * Reference page-bg color matching the app's `--bg` CSS token.
   *
   * NOTE: `drawFrame` does NOT paint this — it `clearRect`s the canvas
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
  /** Horizontal measure lines (every 4th beat — slightly stronger). */
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
  /** Lane label color when the gate is being held / sustained — sits on a colored fill. */
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
  // at the canvas corners — visibly grayer than the surrounding page
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
  // label needs to ride on top — light text on saturated color reads well.
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
  /** Index into LANE_RGB — avoids per-particle string storage and reparse. */
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
  /** True for "perfect" — drawn slightly larger and with a white core. */
  intense: boolean;
}

/**
 * Combo milestone strobe — when the player passes 25/50/100/250/500/1000+,
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
  /** Last few judgment events for floating popups. */
  recentEvents: JudgmentEvent[];
  /** Lane flash impulses [0..1] driven by hits. Indexed by lane. */
  laneFlash: number[];
  /**
   * Per-lane "anticipation" pulse [0..1] — set by drawHighway whenever a
   * note is within ANTICIPATION_WINDOW_S of the judge line. Read by
   * drawLaneGate to widen the ring + brighten the glow so the player sees
   * the gate "loading" before the note arrives.
   */
  laneAnticipation: number[];
  /** Active particle pool. Capped to PARTICLE_BUDGET so we can't unbounded-grow. */
  particles: Particle[];
  /** Active shockwave pool — much smaller than particles (capped at 24). */
  shockwaves: Shockwave[];
  /** Hit events pushed by the game; renderer drains and converts to particles. */
  pendingHits: PendingHit[];
  /** Combo to display on the canvas. Set by Game.tsx every frame. */
  combo: number;
  /** Latest combo-milestone flash, or null. Decayed in-place. */
  milestone: MilestoneFlash | null;
  /** Cached canvas geometry + gradients (only rebuilt when canvas size changes). */
  cache?: RenderCache;
}

interface RenderCache {
  W: number;
  H: number;
  /** Theme the cached gradients were baked for — invalidates the cache on swap. */
  paletteId: ThemeName;
  vignette: CanvasGradient;
  highway: CanvasGradient;
  /** Milestone vignette gradient — only recreated on resize/theme swap.
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
  /** Per-lane judge-line X (pre-computed for particle spawn). */
  laneX: number[];
  /** Per-(N-1) lane separator endpoint pairs.
   *  Six `lerp()` calls per separator per frame were redundant since the
   *  highway geometry only changes on resize. Pre-baked here so the
   *  separator pass becomes a tight stroke loop. */
  separatorTopX: number[];
  separatorBotX: number[];
}

const PARTICLE_BUDGET = 200;
const SHOCKWAVE_BUDGET = 24;
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
 * the alpha resets back to 1 and fades a second time — that "flicker pop"
 * is exactly what reads as the note "still being there" to the player.
 *
 * Solution: take the MINIMUM of the two fades each frame. The grace fade
 * keeps decaying continuously while the judged fade tracks just-hit
 * notes that judged near the line. min() means the alpha never re-rises.
 *
 * Both use a fast ease-out curve (quadratic) so the note loses most of
 * its visual weight in the first ~40% of the window — feels snappy
 * rather than "lingering ghost note".
 */
const JUDGED_FADE_S = 0.10;
const PAST_GRACE_S = 0.16;
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

function hexToRgb(hex: string): RGB {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

export const DEFAULT_RENDER_OPTIONS: RenderOptions = {
  leadTime: 1.2,
  laneHeld: new Array(TOTAL_LANES).fill(false),
  judgeLineY: 0.78,
  bpm: 161,
  offset: 0.18,
  theme: "dark",
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
  };
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

interface Highway {
  bottomLeftX: number;
  bottomRightX: number;
  topLeftX: number;
  topRightX: number;
  topY: number;
  judgeY: number;
}

/**
 * Draw one frame. Coordinates are CSS pixels — caller pre-applies devicePixelRatio
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
): void {
  const W = ctx.canvas.clientWidth;
  const H = ctx.canvas.clientHeight;
  const palette = getPalette(opts.theme);
  const cache = ensureCache(ctx, rs, W, H, palette, opts);

  // Clear to fully-transparent (NOT opaque pageBg) so the underlying
  // body background shows through. The body uses `rgb(var(--bg))`
  // which is wired into the same 220ms cubic-bezier theme transition
  // that fades the header / footer / landing-page surface — so the
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

  const hw: Highway = {
    bottomLeftX: cache.bottomLeftX,
    bottomRightX: cache.bottomRightX,
    topLeftX: cache.topLeftX,
    topRightX: cache.topRightX,
    topY: cache.topY,
    judgeY: cache.judgeY,
  };

  const beatLen = 60 / opts.bpm;
  const firstBeat =
    Math.floor((songTime - opts.offset) / beatLen) * beatLen + opts.offset;
  const beatsToDraw = Math.ceil(opts.leadTime / beatLen) + 2;

  const phase = ((songTime - opts.offset) % beatLen + beatLen) % beatLen;
  const beatProgress = phase / beatLen;
  const beatPulse = Math.pow(1 - beatProgress, 3);
  const isDownbeat =
    Math.round((songTime - opts.offset) / beatLen) % 4 === 0;

  drainHits(rs, cache);
  decayMilestone(rs, dt);

  drawHighway(
    ctx, hw, state, songTime, opts, rs,
    firstBeat, beatLen, beatsToDraw, beatPulse, isDownbeat, cache, palette,
  );

  updateAndDrawShockwaves(ctx, rs, dt, palette);
  updateAndDrawParticles(ctx, rs, dt);

    drawCanvasCombo(ctx, rs, cache, palette);
  drawJudgmentPopups(ctx, rs.recentEvents, songTime, cache.judgeY - 50, cache);
  drawBeatDot(ctx, W - 28, 28, beatPulse, isDownbeat, palette);
  drawMilestoneVignette(ctx, rs, W, H, cache);
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
    rs.cache.paletteId === palette.id
  ) {
    return rs.cache;
  }

  const judgeY = H * opts.judgeLineY;
  const topY = H * 0.05;
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
  const topHalf = bottomHalf * 0.5;
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

  const highway = ctx.createLinearGradient(0, topY, 0, judgeY);
  highway.addColorStop(0, palette.highwayStops[0]);
  highway.addColorStop(0.7, palette.highwayStops[1]);
  highway.addColorStop(1, palette.highwayStops[2]);

  const laneX: number[] = [];
  for (let i = 0; i < MAIN_LANE_COUNT; i++) {
    const f = (i + 0.5) / MAIN_LANE_COUNT;
    laneX.push(lerp(bottomLeftX, bottomRightX, f));
  }
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
  // — caching it dropped milestone-active frames from ~6.5ms to ~5.2ms
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
    vignette, highway, milestoneVignette,
    cx, bottomLeftX, bottomRightX, topLeftX, topRightX,
    topY, judgeY, laneX,
    separatorTopX, separatorBotX,
  };
  return rs.cache;
}

// ---------------------------------------------------------------------------
function drawHighway(
  ctx: CanvasRenderingContext2D,
  hw: Highway,
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
) {
  // Trapezoid floor
  ctx.beginPath();
  ctx.moveTo(hw.topLeftX, hw.topY);
  ctx.lineTo(hw.topRightX, hw.topY);
  ctx.lineTo(hw.bottomRightX, hw.judgeY + 50);
  ctx.lineTo(hw.bottomLeftX, hw.judgeY + 50);
  ctx.closePath();
  ctx.fillStyle = cache.highway;
  ctx.fill();

  // Combo milestone bumps the rails' brightness + glow on top of the
  // beat pulse — a "you're cooking" moment that lasts ~700ms then fades.
  const ms = rs.milestone?.strength ?? 0;
  const railAlpha = clamp(0.55 + beatPulse * 0.45 + ms * 0.4, 0, 1);
  const railBlur = 10 + beatPulse * (isDownbeat ? 22 : 12) + ms * 28;
  ctx.save();
  ctx.lineWidth = 3 + ms * 1.5;
  ctx.strokeStyle = rgba(palette.accentRgb, railAlpha);
  ctx.shadowColor = rgba(palette.accentRgb, 0.85);
  ctx.shadowBlur = railBlur;
  ctx.beginPath();
  ctx.moveTo(hw.topLeftX, hw.topY);
  ctx.lineTo(hw.bottomLeftX, hw.judgeY + 50);
  ctx.moveTo(hw.topRightX, hw.topY);
  ctx.lineTo(hw.bottomRightX, hw.judgeY + 50);
  ctx.stroke();
  ctx.restore();

  // Lane separators — endpoints baked once in `ensureCache` so this is
  // just N strokes per frame, no `lerp()` per separator.
  ctx.strokeStyle = palette.laneSeparator;
  ctx.lineWidth = 1;
  const sepBotY = hw.judgeY + 50;
  for (let i = 0; i < cache.separatorTopX.length; i++) {
    ctx.beginPath();
    ctx.moveTo(cache.separatorTopX[i], hw.topY);
    ctx.lineTo(cache.separatorBotX[i], sepBotY);
    ctx.stroke();
  }

  for (let b = 0; b < beatsToDraw; b++) {
    const t = firstBeat + b * beatLen;
    const progress = (t - songTime) / opts.leadTime;
    if (progress < 0 || progress > 1) continue;
    const y = hw.topY + (hw.judgeY - hw.topY) * (1 - progress);
    const xL = lerp(hw.topLeftX, hw.bottomLeftX, 1 - progress);
    const xR = lerp(hw.topRightX, hw.bottomRightX, 1 - progress);
    const isMeasure = Math.round((t - opts.offset) / beatLen) % 4 === 0;
    ctx.strokeStyle = isMeasure ? palette.measureLine : palette.beatLine;
    ctx.lineWidth = isMeasure ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(xL, y);
    ctx.lineTo(xR, y);
    ctx.stroke();
  }

  // Notes — draw hold trails first (behind), then heads.
  // Indexed loops over state.notes (instead of `for...of`) avoid the
  // per-frame Iterator object allocation. On dense charts (~3000 notes) the
  // hot path is called twice per frame, so this saves measurable GC.
  const notes = state.notes;
  const len = notes.length;
  for (let i = 0; i < len; i++) {
    const n = notes[i];
    if (!isHold(n)) continue;
    const headLook = n.t - songTime;
    const tailLook = (n.endT as number) - songTime;
    if (headLook > opts.leadTime + 0.05 && tailLook > opts.leadTime + 0.05) {
      if (headLook > opts.leadTime + 1) break;
      continue;
    }
    // Hold trail fade — same min() pattern as tap notes so the engine's
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
    drawHoldTrail(ctx, n, songTime, opts, hw, palette, trailAlpha);
  }
  // Reset anticipation each frame; we re-derive it from the upcoming notes.
  for (let i = 0; i < rs.laneAnticipation.length; i++) rs.laneAnticipation[i] = 0;
  for (let i = 0; i < len; i++) {
    const n = notes[i];
    const lookahead = n.t - songTime;
    if (lookahead > opts.leadTime + 0.05) {
      if (lookahead > opts.leadTime + 1) break;
      continue;
    }
    // Compute fade alpha as the MIN of the two pathways so the alpha
    // is monotonically decreasing — see JUDGED_FADE_S/PAST_GRACE_S
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
    // Anticipation only fires for upcoming (non-judged) notes — once the
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
    drawTapNote(ctx, n, lookahead, opts, hw, palette, alpha);
  }

  // Judgment line — subtle pulse on the beat AND on combo milestones.
  ctx.save();
  ctx.strokeStyle = rgba(
    palette.judgeRgb,
    clamp(palette.judgeBaseAlpha + beatPulse * 0.15 + ms * 0.2, 0, 1),
  );
  ctx.lineWidth = 2 + ms * 1;
  ctx.shadowColor = rgba(palette.accentRgb, 0.85);
  ctx.shadowBlur = 14 + beatPulse * 14 + ms * 22;
  ctx.beginPath();
  ctx.moveTo(hw.bottomLeftX + 4, hw.judgeY);
  ctx.lineTo(hw.bottomRightX - 4, hw.judgeY);
  ctx.stroke();
  ctx.restore();

  // Per-lane judgment-line "kiss" — a tiny accent segment under each gate
  // that swells with the lane's most recent flash. Reads as the lane
  // "lighting up the floor" for half a beat after a hit. Cheap.
  for (let i = 0; i < MAIN_LANE_COUNT; i++) {
    const flash = rs.laneFlash[i] ?? 0;
    if (flash <= 0.05) continue;
    const f = (i + 0.5) / MAIN_LANE_COUNT;
    const x = lerp(hw.bottomLeftX, hw.bottomRightX, f);
    const w = 36 + flash * 28;
    ctx.save();
    ctx.strokeStyle = rgba(LANE_RGB[i], 0.35 + flash * 0.55);
    ctx.shadowColor = LANE_COLORS[i];
    ctx.shadowBlur = 14 + flash * 18;
    ctx.lineWidth = 3 + flash * 2;
    ctx.beginPath();
    ctx.moveTo(x - w / 2, hw.judgeY);
    ctx.lineTo(x + w / 2, hw.judgeY);
    ctx.stroke();
    ctx.restore();
  }

  for (let i = 0; i < MAIN_LANE_COUNT; i++) {
    const f = (i + 0.5) / MAIN_LANE_COUNT;
    const x = lerp(hw.bottomLeftX, hw.bottomRightX, f);
    drawLaneGate(
      ctx,
      i,
      x,
      hw.judgeY,
      opts.laneHeld[i] ?? false,
      rs.laneFlash[i] ?? 0,
      state.isHolding(i),
      rs.laneAnticipation[i] ?? 0,
      palette,
    );
  }
}

// ---------------------------------------------------------------------------
function drawTapNote(
  ctx: CanvasRenderingContext2D,
  n: Note,
  lookahead: number,
  opts: RenderOptions,
  hw: Highway,
  palette: ThemePalette,
  alpha: number,
) {
  const progress = lookahead / opts.leadTime;
  const y = hw.topY + (hw.judgeY - hw.topY) * (1 - progress);

  const f = (n.lane + 0.5) / MAIN_LANE_COUNT;
  const xTop = lerp(hw.topLeftX, hw.topRightX, f);
  const xBot = lerp(hw.bottomLeftX, hw.bottomRightX, f);
  const x = lerp(xTop, xBot, 1 - progress);

  const radius = lerp(11.5, 27.5, 1 - progress);
  const color = LANE_COLORS[n.lane];

  ctx.save();
  // Compositing the whole note via globalAlpha keeps the layered fills
  // (ring + inner + core) fading together rather than each one having to
  // bake the alpha into its own color string.
  ctx.globalAlpha = alpha;
  // Glow only on notes near the judge line. Far-up notes are tiny and
  // their shadow blur contributes almost nothing visually but costs an
  // entire offscreen pass per shape — on dense charts (40+ visible notes)
  // skipping the upper-half blurs trims meaningful frame time on
  // mid-range GPUs without changing the look in the player's focal area.
  // We always glow once a note starts fading (alpha < 1), since that's
  // the moment it sits at/near the line and visual punch matters most.
  const closeToLine = progress < 0.55 || alpha < 1;
  if (closeToLine) {
    ctx.shadowColor = color;
    ctx.shadowBlur = 18 * alpha;
  }
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = palette.noteInner;
  ctx.beginPath();
  ctx.arc(x, y, radius * 0.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = palette.noteCore;
  ctx.beginPath();
  ctx.arc(x, y, radius * 0.28, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
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
  hw: Highway,
  palette: ThemePalette,
  alphaMul: number,
) {
  const headLook = n.t - songTime;
  const tailLook = (n.endT as number) - songTime;

  const headProgress = clamp(headLook / opts.leadTime, -0.2, 1.05);
  const tailProgress = clamp(tailLook / opts.leadTime, -0.2, 1.05);

  // Convert lookahead progress (1=top, 0=judge line) to canvas y.
  const yFromProgress = (p: number) =>
    hw.topY + (hw.judgeY - hw.topY) * (1 - p);

  // Trail visible only between top of highway and the judgment line.
  // Once the head crosses the judgment line, "freeze" the head at the line
  // (the player should be holding the lane gate, not chasing the head down).
  const visHead = Math.min(1, Math.max(0, headProgress));
  const visTail = Math.min(1, Math.max(0, tailProgress));
  if (visHead === 0 && visTail === 0) return; // entirely past judgment line
  if (visTail >= 1 && visHead >= 1) return;   // entirely off-screen up top

  const yHead = yFromProgress(visHead);
  const yTail = yFromProgress(visTail);

  const f = (n.lane + 0.5) / MAIN_LANE_COUNT;
  const xHeadTop = lerp(hw.topLeftX, hw.topRightX, f);
  const xHeadBot = lerp(hw.bottomLeftX, hw.bottomRightX, f);
  const xHead = lerp(xHeadTop, xHeadBot, 1 - visHead);
  const xTail = lerp(xHeadTop, xHeadBot, 1 - visTail);

  // Width tapers with perspective just like the notes themselves.
  const wHead = lerp(10.5, 27.5, 1 - visHead);
  const wTail = lerp(10.5, 27.5, 1 - visTail);

  const color = LANE_COLORS[n.lane];
  const colorRgb = LANE_RGB[n.lane];
  const consumed = n.holding === true;
  const alpha = consumed ? 0.85 : n.tailJudged === "miss" ? 0.18 : 0.55;

  ctx.save();
  ctx.globalAlpha = alphaMul;
  ctx.fillStyle = rgba(colorRgb, alpha);
  // Same "near the line" gating as drawTapNote — a hold trail's shadow
  // is the most expensive part of its draw, but visually only matters
  // when the head is close to the judge line OR the note is being
  // actively sustained (consumed). Far-up trails skip the blur entirely.
  const trailNearLine = visHead < 0.55 || visTail < 0.55;
  if (consumed || trailNearLine) {
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
  ctx.strokeStyle = rgba(colorRgb, consumed ? 1 : 0.7);
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();

  // Tail cap (so the player can clearly see when to release).
  if (visTail > 0 && visTail < 1) {
    ctx.save();
    ctx.fillStyle = palette.noteInner;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.shadowColor = color;
    ctx.shadowBlur = 12;
    const capH = Math.max(4, wTail * 0.35);
    ctx.beginPath();
    ctx.rect(xTail - wTail / 2, yTail - capH / 2, wTail, capH);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
function drawLaneGate(
  ctx: CanvasRenderingContext2D,
  lane: number,
  x: number,
  y: number,
  held: boolean,
  flash: number,
  holding: boolean,
  anticipation: number,
  palette: ThemePalette,
) {
  // Gate geometry. Tuned so the letter+arrow stack reads as a single,
  // centered glyph block — see LETTER_DY / ARROW_DY below for the exact
  // offsets that compensate for canvas text metrics.
  const r = 38;            // outer ring radius
  const innerRingR = r - 5;  // held-color disk (sits inside the ring)
  const innerCoreR = r - 11; // page-color core (where the label lives)

  const color = LANE_COLORS[lane];
  const colorRgb = LANE_RGB[lane];

  // Anticipation halo: a soft outer ring drawn behind everything else when
  // a note is about to land in this lane. Quadratic ease so the halo isn't
  // visible 200ms out — it materializes only in the last ~100ms.
  if (anticipation > 0.05) {
    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = rgba(colorRgb, 0.35 * anticipation);
    ctx.shadowColor = color;
    ctx.shadowBlur = 18 * anticipation;
    ctx.beginPath();
    ctx.arc(x, y, r + 6 + anticipation * 4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  ctx.save();
  ctx.lineWidth = 4;
  ctx.strokeStyle = color;
  ctx.shadowColor = color;
  // Held / flash glow + a small lift from anticipation so the gate "pulls"
  // as the note approaches — extra anticipatory feel before any keypress.
  ctx.shadowBlur =
    held || holding ? 26 : 8 + flash * 22 + anticipation * 12;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();

  // Held / flash fill — extra strong while sustaining a hold.
  const fillAlpha = Math.max(
    holding ? 0.95 : held ? 0.85 : 0,
    flash,
  );
  if (fillAlpha > 0) {
    ctx.fillStyle = rgba(colorRgb, fillAlpha);
    ctx.beginPath();
    ctx.arc(x, y, innerRingR, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.shadowBlur = 0;
  ctx.fillStyle = palette.gateInner;
  ctx.beginPath();
  ctx.arc(x, y, innerCoreR, 0, Math.PI * 2);
  ctx.fill();

  // Label + arrow always render in the lane color so they stay legible on
  // the dark gateInner regardless of held state. (Earlier versions tried
  // to flip the color to gateLabelOnFill on press, but gateInner is the
  // *same* tone as gateLabelOnFill in both themes — the label vanished.)
  // When pressed/held we instead add a soft white shine: a glow halo
  // around the glyph plus a small alpha bump. Reads as "the key lit up"
  // rather than the letter going dark.
  // LETTER_DY / ARROW_DY position the pair so its visual midpoint lands on
  // (x, y) — the circle center. With "middle" baseline a 26px ExtraBold cap
  // is ~18px tall, the arrow is 11px tall, with a 4px gap between them:
  //   stack height ≈ 18 + 4 + 11 = 33
  //   letter center → y - 7.5, arrow center → y + 10  → rounded below.
  const LETTER_DY = -8;
  const ARROW_DY = 10;
  const ARROW_SIZE = 11;

  // Press shine intensity — strongest on an active hold sustain, slightly
  // softer on a normal keypress, fades out alongside the lane flash.
  const shine = holding ? 1 : held ? 0.85 : flash * 0.6;

  ctx.fillStyle = color;
  if (shine > 0.05) {
    // White-on-color glow halo: blooms the glyph silhouette without
    // washing out the lane color underneath. The shadow stacks under the
    // fill so the letter itself stays crisp.
    ctx.shadowColor = `rgba(255,255,255,${(0.55 * shine).toFixed(3)})`;
    ctx.shadowBlur = 14 * shine;
  } else {
    ctx.shadowBlur = 0;
  }
  // 800 (ExtraBold) is the heaviest weight loaded for JetBrains Mono — see
  // app/layout.tsx. Asking for 900 here would silently fall back to 700
  // (the next loaded weight) and make the letter look the same as
  // font-bold. The size bump to 26 gives the glyph the visual mass we
  // want vs the chevron sitting under it.
  ctx.font = "800 26px var(--font-mono), ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(LANE_LABEL[lane], x, y + LETTER_DY);

  // Brutalist arrow indicator under the letter — drawn as a real canvas
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
    rgba(colorRgb, arrowAlpha),
    shine,
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
    ctx.shadowColor = `rgba(255,255,255,${(0.45 * shine).toFixed(3)})`;
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

function drawJudgmentPopups(
  ctx: CanvasRenderingContext2D,
  events: JudgmentEvent[],
  songTime: number,
  y: number,
  cache: RenderCache,
) {
  ctx.save();
  ctx.textAlign = "center";
  for (const ev of events) {
    const age = songTime - ev.at;
    if (age < 0 || age > 0.6) continue;
    const t = age / 0.6;
    // Cubic-out lift: fast at the start, settles at the top — reads as a
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
    const fontPx = 18 * scale;
    ctx.font = `800 ${fontPx.toFixed(1)}px var(--font-display), system-ui, sans-serif`;
    const baseLabel =
      ev.judgment === "perfect" ? "PERFECT"
      : ev.judgment === "great" ? "GREAT"
      : ev.judgment === "good"  ? "GOOD"
      : "MISS";
    const label = ev.tail ? `${baseLabel}·HOLD` : baseLabel;
    const color =
      ev.judgment === "perfect" ? "#3da9ff"
      : ev.judgment === "great" ? "#3dff8a"
      : ev.judgment === "good"  ? "#ffd23f"
      : "#ff3b6b";
    const x = cache.laneX[ev.lane] ?? cache.cx;
    ctx.fillStyle = withAlpha(color, alpha);
    ctx.shadowColor = color;
    ctx.shadowBlur = 12 * alpha;
    ctx.fillText(label, x, y + yOff);
  }
  ctx.shadowBlur = 0;
  ctx.restore();
}

// ---------------------------------------------------------------------------
/**
 * Big combo number rendered straight on the canvas above the judge line.
 * Only shows once the combo passes 10 — below that the HUD card already
 * carries the information and a giant "5" on the highway looks silly.
 *
 * Sized to swell on milestones, fade slightly on the off-beat. Cheap: a
 * single fillText call per frame.
 */
function drawCanvasCombo(
  ctx: CanvasRenderingContext2D,
  rs: RenderState,
  cache: RenderCache,
  palette: ThemePalette,
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
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.font = `800 ${size.toFixed(0)}px var(--font-display), system-ui, sans-serif`;
  ctx.fillStyle = rgba(palette.accentRgb, alpha);
  ctx.shadowColor = rgba(palette.accentRgb, 0.6);
  ctx.shadowBlur = 18 + ms * 28;
  ctx.fillText(`${rs.combo}`, cache.cx, y);
  ctx.shadowBlur = 0;
  ctx.font = `800 ${(size * 0.22).toFixed(0)}px var(--font-mono), ui-monospace, monospace`;
  ctx.fillStyle = rgba(palette.accentRgb, clamp(alpha * 0.85, 0, 1));
  ctx.fillText("COMBO", cache.cx, y + 14);
  ctx.restore();
}

// ---------------------------------------------------------------------------
/**
 * Brief tinted vignette on milestone — a screen-edge accent flash that
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
  // Curve: peak quickly then trail off — feels like a flash, not a pulse.
  // `lighter` blend lets the accent edge punch *through* the highway
  // colors instead of muddying them, which is what gives the milestone
  // its characteristic "screen reacts" arcade pop.
  // Uses the cached `cache.milestoneVignette` (baked at unit alpha for
  // the accent) — globalAlpha scales the flash without rebuilding the
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
// Shockwave rings — drawn between the highway pass and the particles. Use
// `lighter` blend so overlapping waves stack into a brighter peak rather
// than canceling each other out, matching osu!mania's hit feedback feel.
// ---------------------------------------------------------------------------
function updateAndDrawShockwaves(
  ctx: CanvasRenderingContext2D,
  rs: RenderState,
  dt: number,
  palette: ThemePalette,
): void {
  const sw = rs.shockwaves;
  if (sw.length === 0) return;
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
    const colorRgb = LANE_RGB[s.laneIdx];
    ctx.lineWidth = (s.intense ? 3 : 2) * (1 - t * 0.6);
    ctx.strokeStyle = rgba(colorRgb, alpha);
    ctx.shadowColor = LANE_COLORS[s.laneIdx];
    ctx.shadowBlur = (s.intense ? 26 : 14) * (1 - t);
    ctx.beginPath();
    ctx.arc(s.x, s.y, radius, 0, Math.PI * 2);
    ctx.stroke();
    if (s.intense && t < 0.4) {
      // White core for the first ~180ms of perfect hits — the splash that
      // your eye reads as "yes that was clean".
      ctx.strokeStyle = `rgba(255,255,255,${(0.55 * (1 - t * 2.5)).toFixed(3)})`;
      ctx.lineWidth = 1.5;
      ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.arc(s.x, s.y, radius * 0.55, 0, Math.PI * 2);
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
) {
  ctx.save();
  // Downbeats use the brand accent (theme-shifted), off-beats use the
  // theme's idle dot color so the marker stays visible on either bg.
  const colorRgb = isDownbeat ? palette.accentRgb : hexToRgb(palette.beatDotIdle);
  const colorCss = `rgb(${colorRgb.r},${colorRgb.g},${colorRgb.b})`;
  const r = 5 + pulse * 5;
  ctx.shadowColor = colorCss;
  ctx.shadowBlur = 8 + pulse * 16;
  ctx.fillStyle = rgba(colorRgb, 0.35 + pulse * 0.65);
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Particle system — small, no shadow blur, capped by PARTICLE_BUDGET.
// What it does: on a successful tap the renderer spawns ~16 particles at
// the lane gate. They fly upward with random spread, fade, and shrink.
// Cheap to draw (filled circles, no shadow), but huge perceived polish gain.
// ---------------------------------------------------------------------------

function drainHits(rs: RenderState, cache: RenderCache): void {
  if (rs.pendingHits.length === 0) return;
  for (const h of rs.pendingHits) {
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

const GRAVITY = 480; // px/sec^2 — gentle pull so particles arc

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
    ctx.fillStyle = rgba(LANE_RGB[p.laneIdx], a * a);
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * (0.4 + a * 0.6), 0, Math.PI * 2);
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

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Convert "#rrggbb" to "rgba(r,g,b,a)". Slow path — three parseInts each call.
 * Prefer the pre-parsed `rgba(LANE_RGB[i], a)` form on per-frame hot paths.
 * Kept here for one-off colors (popup grades, beat dot variants).
 */
function withAlpha(hex: string, a: number) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

