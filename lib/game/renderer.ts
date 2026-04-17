import { GameState, JudgmentEvent, isHold } from "./engine";
import {
  Judgment,
  LANE_ALT_LABEL,
  LANE_COLORS,
  LANE_LABEL,
  MAIN_LANE_COUNT,
  Note,
  TOTAL_LANES,
} from "./types";

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
  color: string;
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

export const DEFAULT_RENDER_OPTIONS: RenderOptions = {
  leadTime: 1.2,
  laneHeld: new Array(TOTAL_LANES).fill(false),
  judgeLineY: 0.78,
  bpm: 161,
  offset: 0.18,
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
  const cache = ensureCache(ctx, rs, W, H);

  ctx.fillStyle = "#050608";
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

  // Drain pendingHits → spawn particles at the matching lane gate.
  drainHits(rs, cache);

  drawHighway(
    ctx, hw, state, songTime, opts, rs,
    firstBeat, beatLen, beatsToDraw, beatPulse, isDownbeat, cache,
  );

  // Update + draw particles AFTER notes/gates so they pop on top.
  updateAndDrawParticles(ctx, rs, dt);

  drawJudgmentPopups(ctx, rs.recentEvents, songTime, cache.judgeY - 50, cache);
  drawBeatDot(ctx, W - 28, 28, beatPulse, isDownbeat);
}

// ---------------------------------------------------------------------------
function ensureCache(
  _ctx: CanvasRenderingContext2D,
  rs: RenderState,
  W: number,
  H: number,
): RenderCache {
  if (rs.cache && rs.cache.W === W && rs.cache.H === H) return rs.cache;

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
  vignette.addColorStop(1, "rgba(0,0,0,0.85)");

  const highway = ctx.createLinearGradient(0, topY, 0, judgeY);
  highway.addColorStop(0, "#0a0c10");
  highway.addColorStop(0.7, "#10131a");
  highway.addColorStop(1, "#181c25");

  const laneX: number[] = [];
  for (let i = 0; i < MAIN_LANE_COUNT; i++) {
    const f = (i + 0.5) / MAIN_LANE_COUNT;
    laneX.push(lerp(bottomLeftX, bottomRightX, f));
  }

  rs.cache = {
    W, H,
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
  ctx.strokeStyle = `rgba(61,169,255,${railAlpha})`;
  ctx.shadowColor = "rgba(61,169,255,0.85)";
  ctx.shadowBlur = railBlur;
  ctx.beginPath();
  ctx.moveTo(hw.topLeftX, hw.topY);
  ctx.lineTo(hw.bottomLeftX, hw.judgeY + 50);
  ctx.moveTo(hw.topRightX, hw.topY);
  ctx.lineTo(hw.bottomRightX, hw.judgeY + 50);
  ctx.stroke();
  ctx.restore();

  ctx.strokeStyle = "rgba(255,255,255,0.06)";
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
    ctx.strokeStyle = isMeasure
      ? "rgba(255,255,255,0.22)"
      : "rgba(255,255,255,0.07)";
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
    drawHoldTrail(ctx, n, songTime, opts, hw);
  }
  for (const n of state.notes) {
    if (n.judged) continue;
    const lookahead = n.t - songTime;
    if (lookahead > opts.leadTime + 0.05) {
      if (lookahead > opts.leadTime + 1) break;
      continue;
    }
    if (lookahead < -0.2) continue;
    drawTapNote(ctx, n, lookahead, opts, hw);
  }

  // Judgment line — subtle pulse on the beat too.
  ctx.save();
  ctx.strokeStyle = `rgba(245,245,240,${0.85 + beatPulse * 0.15})`;
  ctx.lineWidth = 2;
  ctx.shadowColor = "rgba(61,169,255,0.85)";
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
  ctx.fillStyle = "#0a0c10";
  ctx.beginPath();
  ctx.arc(x, y, radius * 0.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#f5f5f0";
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
  const consumed = n.holding === true;
  const alpha = consumed ? 0.85 : n.tailJudged === "miss" ? 0.18 : 0.55;

  ctx.save();
  ctx.fillStyle = withAlpha(color, alpha);
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
  ctx.strokeStyle = withAlpha(color, consumed ? 1 : 0.7);
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();

  // Tail cap (so the player can clearly see when to release).
  if (visTail > 0 && visTail < 1) {
    ctx.save();
    ctx.fillStyle = "#0a0c10";
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
) {
  const r = 30;
  const color = LANE_COLORS[lane];

  ctx.save();
  ctx.lineWidth = 4;
  ctx.strokeStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = held || holding ? 24 : 8 + flash * 22;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();

  // Held / flash fill — extra strong while sustaining a hold.
  const fillAlpha = Math.max(
    holding ? 0.95 : held ? 0.85 : 0,
    flash,
  );
  if (fillAlpha > 0) {
    ctx.fillStyle = withAlpha(color, fillAlpha);
    ctx.beginPath();
    ctx.arc(x, y, r - 4, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.shadowBlur = 0;
  ctx.fillStyle = "#0a0c10";
  ctx.beginPath();
  ctx.arc(x, y, r - 10, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = held || holding ? "#0a0c10" : color;
  ctx.font = "800 18px var(--font-mono), ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(LANE_LABEL[lane], x, y - 4);

  ctx.font = "600 11px var(--font-mono), ui-monospace, monospace";
  ctx.fillStyle = held || holding ? "rgba(10,12,16,0.7)" : withAlpha(color, 0.7);
  ctx.fillText(LANE_ALT_LABEL[lane] ?? "", x, y + 12);
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
) {
  ctx.save();
  const color = isDownbeat ? "#3da9ff" : "#f5f5f0";
  const r = 5 + pulse * 5;
  ctx.shadowColor = color;
  ctx.shadowBlur = 8 + pulse * 16;
  ctx.fillStyle = withAlpha(color, 0.35 + pulse * 0.65);
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
    const color = LANE_COLORS[h.lane] ?? "#3da9ff";
    const count =
      h.judgment === "perfect" ? 18 : h.judgment === "great" ? 12 : 6;
    const speed =
      h.judgment === "perfect" ? 380 : h.judgment === "great" ? 280 : 180;
    spawnBurst(rs, x, y, color, count, speed, h.tail === true);
  }
  rs.pendingHits.length = 0;
}

function spawnBurst(
  rs: RenderState,
  x: number,
  y: number,
  color: string,
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
      color,
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
    ctx.fillStyle = withAlpha(p.color, a * a);
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

function withAlpha(hex: string, a: number) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}
