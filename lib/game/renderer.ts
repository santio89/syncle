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
  /** Solid background painted before the vignette and highway. */
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
  // Light-mode vignette is a soft darken-to-edges (instead of darken-to-black)
  // so the highway sits in a pool of attention without bruising the bg.
  vignetteOuter: "rgba(20,18,14,0.18)",
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

export interface RenderState {
  /** Last few judgment events for floating popups. */
  recentEvents: JudgmentEvent[];
  /** Lane flash impulses [0..1] driven by hits. Indexed by lane. */
  laneFlash: number[];
  /** Active particle pool. Capped to PARTICLE_BUDGET so we can't unbounded-grow. */
  particles: Particle[];
  /** Hit events pushed by the game; renderer drains and converts to particles. */
  pendingHits: PendingHit[];
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
  cx: number;
  bottomLeftX: number;
  bottomRightX: number;
  topLeftX: number;
  topRightX: number;
  topY: number;
  judgeY: number;
  /** Per-lane judge-line X (pre-computed for particle spawn). */
  laneX: number[];
}

const PARTICLE_BUDGET = 200;

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
  const cache = ensureCache(ctx, rs, W, H, palette);

  ctx.fillStyle = palette.pageBg;
  ctx.fillRect(0, 0, W, H);
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

  drawHighway(
    ctx, hw, state, songTime, opts, rs,
    firstBeat, beatLen, beatsToDraw, beatPulse, isDownbeat, cache, palette,
  );

  updateAndDrawParticles(ctx, rs, dt);

  drawJudgmentPopups(ctx, rs.recentEvents, songTime, cache.judgeY - 50, cache);
  drawBeatDot(ctx, W - 28, 28, beatPulse, isDownbeat, palette);
}

// ---------------------------------------------------------------------------
function ensureCache(
  _ctx: CanvasRenderingContext2D,
  rs: RenderState,
  W: number,
  H: number,
  palette: ThemePalette,
): RenderCache {
  if (
    rs.cache &&
    rs.cache.W === W &&
    rs.cache.H === H &&
    rs.cache.paletteId === palette.id
  ) {
    return rs.cache;
  }

  const judgeY = H * DEFAULT_RENDER_OPTIONS.judgeLineY;
  const topY = H * 0.05;
  const cx = W / 2;
  const bottomHalf = Math.min(280, W * 0.32);
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

  rs.cache = {
    W, H,
    paletteId: palette.id,
    vignette, highway,
    cx, bottomLeftX, bottomRightX, topLeftX, topRightX,
    topY, judgeY, laneX,
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

  const railAlpha = 0.55 + beatPulse * 0.45;
  const railBlur = 10 + beatPulse * (isDownbeat ? 22 : 12);
  ctx.save();
  ctx.lineWidth = 3;
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

  ctx.strokeStyle = palette.laneSeparator;
  ctx.lineWidth = 1;
  for (let i = 1; i < MAIN_LANE_COUNT; i++) {
    const f = i / MAIN_LANE_COUNT;
    const xTop = lerp(hw.topLeftX, hw.topRightX, f);
    const xBot = lerp(hw.bottomLeftX, hw.bottomRightX, f);
    ctx.beginPath();
    ctx.moveTo(xTop, hw.topY);
    ctx.lineTo(xBot, hw.judgeY + 50);
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
  for (const n of state.notes) {
    if (!isHold(n)) continue;
    if (n.tailJudged) continue;
    const headLook = n.t - songTime;
    const tailLook = (n.endT as number) - songTime;
    if (headLook > opts.leadTime + 0.05 && tailLook > opts.leadTime + 0.05) {
      if (headLook > opts.leadTime + 1) break;
      continue;
    }
    if (tailLook < -0.2) continue;
    drawHoldTrail(ctx, n, songTime, opts, hw, palette);
  }
  for (const n of state.notes) {
    if (n.judged) continue;
    const lookahead = n.t - songTime;
    if (lookahead > opts.leadTime + 0.05) {
      if (lookahead > opts.leadTime + 1) break;
      continue;
    }
    if (lookahead < -0.2) continue;
    drawTapNote(ctx, n, lookahead, opts, hw, palette);
  }

  // Judgment line — subtle pulse on the beat too.
  ctx.save();
  ctx.strokeStyle = rgba(palette.judgeRgb, palette.judgeBaseAlpha + beatPulse * 0.15);
  ctx.lineWidth = 2;
  ctx.shadowColor = rgba(palette.accentRgb, 0.85);
  ctx.shadowBlur = 14 + beatPulse * 14;
  ctx.beginPath();
  ctx.moveTo(hw.bottomLeftX + 4, hw.judgeY);
  ctx.lineTo(hw.bottomRightX - 4, hw.judgeY);
  ctx.stroke();
  ctx.restore();

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
) {
  const progress = lookahead / opts.leadTime;
  const y = hw.topY + (hw.judgeY - hw.topY) * (1 - progress);

  const f = (n.lane + 0.5) / MAIN_LANE_COUNT;
  const xTop = lerp(hw.topLeftX, hw.topRightX, f);
  const xBot = lerp(hw.bottomLeftX, hw.bottomRightX, f);
  const x = lerp(xTop, xBot, 1 - progress);

  const radius = lerp(11, 26, 1 - progress);
  const color = LANE_COLORS[n.lane];

  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = 18;
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
  const wHead = lerp(10, 26, 1 - visHead);
  const wTail = lerp(10, 26, 1 - visTail);

  const color = LANE_COLORS[n.lane];
  const colorRgb = LANE_RGB[n.lane];
  const consumed = n.holding === true;
  const alpha = consumed ? 0.85 : n.tailJudged === "miss" ? 0.18 : 0.55;

  ctx.save();
  ctx.fillStyle = rgba(colorRgb, alpha);
  ctx.shadowColor = color;
  ctx.shadowBlur = consumed ? 22 : 10;
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
  palette: ThemePalette,
) {
  // Gate geometry. Tuned so the letter+arrow stack reads as a single,
  // centered glyph block — see LETTER_DY / ARROW_DY below for the exact
  // offsets that compensate for canvas text metrics.
  const r = 36;            // outer ring radius
  const innerRingR = r - 5;  // held-color disk (sits inside the ring)
  const innerCoreR = r - 11; // page-color core (where the label lives)

  const color = LANE_COLORS[lane];
  const colorRgb = LANE_RGB[lane];

  ctx.save();
  ctx.lineWidth = 4;
  ctx.strokeStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = held || holding ? 26 : 8 + flash * 22;
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

  // When the lane is held the inside is filled with the lane color, so the
  // label needs to ride on that fill (gateLabelOnFill); otherwise the
  // label sits over the empty gate interior and uses the lane color itself.
  // LETTER_DY / ARROW_DY position the pair so its visual midpoint lands on
  // (x, y) — the circle center. With "middle" baseline a 26px ExtraBold cap
  // is ~18px tall, the arrow is 11px tall, with a 4px gap between them:
  //   stack height ≈ 18 + 4 + 11 = 33
  //   letter center → y - 7.5, arrow center → y + 10  → rounded below.
  const LETTER_DY = -8;
  const ARROW_DY = 10;
  const ARROW_SIZE = 11;

  ctx.fillStyle = held || holding ? palette.gateLabelOnFill : color;
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
  // in the rest of the UI and respects the active theme palette. Slightly
  // dimmer than the letter so the lane identity reads "letter-first".
  const arrowColor = held || holding
    ? withAlphaCss(palette.gateLabelOnFill, 0.78)
    : rgba(colorRgb, 0.78);
  drawArrow(
    ctx,
    LANE_ARROW_DIR[lane] ?? "down",
    x,
    y + ARROW_DY,
    ARROW_SIZE,
    arrowColor,
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
  ctx.shadowBlur = 0;

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
  ctx.font = "800 18px var(--font-display), system-ui, sans-serif";
  for (const ev of events) {
    const age = songTime - ev.at;
    if (age < 0 || age > 0.6) continue;
    const t = age / 0.6;
    const alpha = 1 - t;
    const yOff = -t * 50;
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
    ctx.shadowBlur = 10 * alpha;
    ctx.fillText(label, x, y + yOff);
  }
  ctx.shadowBlur = 0;
  ctx.restore();
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

/**
 * Same as withAlpha but accepts either "#rrggbb" OR "rgb(...)"-shaped CSS
 * strings — used for palette colors that may be either form depending on
 * how they were authored. Falls back to a parseable hex when it can.
 */
function withAlphaCss(css: string, a: number): string {
  if (css.startsWith("#")) return withAlpha(css, a);
  // rgb(r,g,b) → rgba(r,g,b,a). Tolerates whitespace.
  const m = css.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (m) return `rgba(${m[1]},${m[2]},${m[3]},${a})`;
  return css;
}
