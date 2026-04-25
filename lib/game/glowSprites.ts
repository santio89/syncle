/**
 * Glow sprite cache.
 *
 * Pre-rasterizes shadow-blurred shapes (filled circles + stroked rings)
 * to small offscreen canvases so the hot render loop can paint them as
 * a single `drawImage` blit instead of running `arc + fill/stroke +
 * shadowBlur` every frame.
 *
 * Why this matters:
 *   `ctx.shadowBlur` is the single most expensive Canvas 2D operation
 *   on integrated GPUs and software-rendered fallbacks. Each shadowed
 *   draw triggers a temporary offscreen pass + Gaussian blur on the
 *   CPU. Replacing it with a precomputed bitmap blit is 5-50x faster
 *   on low-end systems and a few % faster everywhere - at zero visual
 *   cost, since the sprite IS the same blurred shape we'd have drawn.
 *
 * Cache strategy:
 *   - Quantize `radius` and `blur` to small integer buckets so animated
 *     values (e.g. `blur = 18 * alpha`) collapse onto a small set of
 *     pre-rendered sprites without any visible "stepping" - glows are
 *     inherently soft, a 12 vs 14 px blur is imperceptible mid-flight
 *     and the renderer modulates `globalAlpha` for the smooth fade
 *     anyway.
 *   - Per-frame alpha is NOT in the key. Callers wrap the blit in
 *     `globalAlpha *= alpha` so one peak-intensity sprite serves an
 *     entire fade-in/out cycle.
 *   - LRU eviction at MAX_ENTRIES keeps memory bounded. The working
 *     set (sprites referenced THIS frame) is small - ~30-50 across all
 *     four lanes at the busiest density - so cache thrash is a
 *     non-issue once warm.
 *   - DPR is baked into each sprite so blits are pixel-perfect on
 *     hi-DPI displays. We read DPR from the destination ctx's
 *     transform (the renderer applies `setTransform(dpr,...,dpr,0,0)`
 *     once per resize), so callers don't have to thread it through.
 *
 * Footprint: each sprite is at most ~80 CSS px squared at DPR 2 →
 * ~25 KB. 128-entry cap → < 4 MB total. Negligible vs. textures we'd
 * upload to a WebGL renderer to do the same job.
 *
 * What's NOT in here (and why):
 *   - Theme-dependent glows (combo digit, judgment text, beat dot).
 *     Those colors change on theme swap; we'd need a cache-clear hook
 *     wired to the theme transition. Keeping them on the original
 *     shadowBlur path costs little (each is 1 call/frame), so the
 *     simplification wins.
 *   - Hold-trail trapezoid glow. The shape varies per frame in
 *     non-quantizable ways (head/tail x's interpolate continuously);
 *     pre-rasterization wouldn't cover the working set.
 */

// Quantization for cache-key bucketing only. The blit ALWAYS happens
// at the caller's exact requested radius (the sprite is scaled at draw
// time to match) - these steps just decide which sprite size we
// reuse, not what size shows on screen. So radius can be coarse
// without any visible "stepping" as the value interpolates.
//
// Blur is more sensitive: it can't be smoothly scaled (scaling a
// peak-blur sprite would also shrink the inner shape), so we quantize
// finer. At step 2 the lane-gate flash decay (40 → 8 over 200 ms)
// crosses ~16 buckets, ~one bucket per frame at 60 Hz - adjacent
// buckets are visually indistinguishable, so the decay reads as a
// continuous fade instead of a strobing pulse like step 4 was.
const QUANTIZE_RADIUS_PX = 4;
const QUANTIZE_BLUR_PX = 2;
const QUANTIZE_LINE_PX = 1;
const MAX_ENTRIES = 192;

const cache = new Map<string, HTMLCanvasElement>();

function quantize(value: number, step: number): number {
  return Math.max(step, Math.round(value / step) * step);
}

function readDpr(ctx: CanvasRenderingContext2D): number {
  // The renderer applies `setTransform(dpr, 0, 0, dpr, 0, 0)` once at
  // resize time and never modifies the transform inside helpers
  // (verified - no scale/translate/rotate calls in the renderer
  // call tree). So `getTransform().a` here always equals DPR.
  // Falling back to 1 if the API isn't available (very old browsers
  // without OffscreenCanvas et al - we ship for evergreen anyway).
  try {
    const t = ctx.getTransform();
    return t.a > 0 ? t.a : 1;
  } catch {
    return 1;
  }
}

function touch(key: string, sprite: HTMLCanvasElement): void {
  // LRU bump: re-insertion at the back marks "most recently used".
  // V8/JSC iterate Maps in insertion order, so the oldest live key
  // is always `cache.keys().next().value` for eviction.
  cache.delete(key);
  cache.set(key, sprite);
}

function evictIfFull(): void {
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function buildFilledCircleSprite(
  color: string,
  radius: number,
  blur: number,
  dpr: number,
): HTMLCanvasElement {
  // Padding: blur extends ~3σ from the shape edge in Canvas 2D's
  // shadow implementation. `blur + 4` covers it with a tiny safety
  // margin so the blur never gets clipped at the sprite's edge.
  const padding = blur + 4;
  const sizeCss = (radius + padding) * 2;
  const sizeDev = Math.max(2, Math.ceil(sizeCss * dpr));
  const c = document.createElement("canvas");
  c.width = c.height = sizeDev;
  const sctx = c.getContext("2d");
  if (!sctx) return c;
  // Match the renderer's DPR transform: 1 unit = 1 CSS px in our
  // sprite coords, exactly like the destination canvas.
  sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cx = sizeCss / 2;
  sctx.shadowColor = color;
  sctx.shadowBlur = blur;
  sctx.fillStyle = color;
  sctx.beginPath();
  sctx.arc(cx, cx, radius, 0, Math.PI * 2);
  sctx.fill();
  return c;
}

function buildStrokedRingSprite(
  color: string,
  radius: number,
  lineWidth: number,
  blur: number,
  dpr: number,
): HTMLCanvasElement {
  const padding = blur + lineWidth + 4;
  const sizeCss = (radius + padding) * 2;
  const sizeDev = Math.max(2, Math.ceil(sizeCss * dpr));
  const c = document.createElement("canvas");
  c.width = c.height = sizeDev;
  const sctx = c.getContext("2d");
  if (!sctx) return c;
  sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cx = sizeCss / 2;
  sctx.shadowColor = color;
  sctx.shadowBlur = blur;
  sctx.strokeStyle = color;
  sctx.lineWidth = lineWidth;
  sctx.beginPath();
  sctx.arc(cx, cx, radius, 0, Math.PI * 2);
  sctx.stroke();
  return c;
}

/**
 * Blit a filled-circle glow centered at (x, y).
 *
 * Replaces the canonical pattern:
 *   ctx.shadowColor = color;
 *   ctx.shadowBlur = blur;
 *   ctx.fillStyle = color;
 *   ctx.beginPath(); ctx.arc(x, y, radius, 0, TAU); ctx.fill();
 *   ctx.shadowBlur = 0;
 *
 * `alpha` is multiplied into `ctx.globalAlpha` for the duration of
 * the blit, then restored - so the caller doesn't need to wrap it
 * in save/restore (and we avoid the cost of save/restore).
 */
export function drawRadialGlow(
  ctx: CanvasRenderingContext2D,
  color: string,
  x: number,
  y: number,
  radius: number,
  blur: number,
  alpha = 1,
): void {
  if (alpha <= 0 || radius <= 0) return;
  const rQ = quantize(radius, QUANTIZE_RADIUS_PX);
  // Blur 0 still has meaning (no glow, just a filled circle), but
  // for our use-cases blur is always > 0 when this path is taken;
  // skip the cache for the blur=0 case to avoid bloating with
  // shadowless variants. Caller would just `ctx.fill()` directly
  // in that case.
  const b = blur > 0 ? quantize(blur, QUANTIZE_BLUR_PX) : 0;
  const dpr = readDpr(ctx);
  const key = `f|${color}|${rQ}|${b}|${dpr}`;
  let sprite = cache.get(key);
  if (sprite) {
    touch(key, sprite);
  } else {
    sprite = buildFilledCircleSprite(color, rQ, b, dpr);
    cache.set(key, sprite);
    evictIfFull();
  }
  // Blit at the caller's EXACT requested size, not the quantized
  // bucket size - the sprite scales linearly via drawImage's
  // dest-rect args. This kills visible "stepping" as `radius`
  // interpolates between cache buckets (notes growing as they fall
  // toward the line, etc.). The blur halo scales proportionally,
  // which slightly softens / shrinks the halo on smaller variants
  // - imperceptible vs. the original at typical scale ratios
  // (≤ 1.0 ± QUANTIZE_RADIUS_PX/r ≈ ± 17 % at the smallest notes,
  // less for everything else).
  const halfCssQ = sprite.width / dpr / 2;
  const scale = radius / rQ;
  const halfCss = halfCssQ * scale;
  const prev = ctx.globalAlpha;
  if (alpha !== 1) ctx.globalAlpha = prev * alpha;
  ctx.drawImage(sprite, x - halfCss, y - halfCss, halfCss * 2, halfCss * 2);
  if (alpha !== 1) ctx.globalAlpha = prev;
}

/**
 * Blit a stroked-ring glow centered at (x, y).
 *
 * Replaces the canonical pattern:
 *   ctx.shadowColor = color;
 *   ctx.shadowBlur = blur;
 *   ctx.strokeStyle = color;
 *   ctx.lineWidth = lineWidth;
 *   ctx.beginPath(); ctx.arc(x, y, radius, 0, TAU); ctx.stroke();
 *   ctx.shadowBlur = 0;
 */
export function drawRingGlow(
  ctx: CanvasRenderingContext2D,
  color: string,
  x: number,
  y: number,
  radius: number,
  lineWidth: number,
  blur: number,
  alpha = 1,
): void {
  if (alpha <= 0 || radius <= 0 || lineWidth <= 0) return;
  const rQ = quantize(radius, QUANTIZE_RADIUS_PX);
  const lw = quantize(lineWidth, QUANTIZE_LINE_PX);
  const b = blur > 0 ? quantize(blur, QUANTIZE_BLUR_PX) : 0;
  const dpr = readDpr(ctx);
  const key = `r|${color}|${rQ}|${lw}|${b}|${dpr}`;
  let sprite = cache.get(key);
  if (sprite) {
    touch(key, sprite);
  } else {
    sprite = buildStrokedRingSprite(color, rQ, lw, b, dpr);
    cache.set(key, sprite);
    evictIfFull();
  }
  // See `drawRadialGlow` for the rationale on actual-size blits.
  // For our current uses the lane-gate radius is fixed at 38, so
  // `scale` is exactly 1 every frame and there's no perceptible
  // difference; this branch exists for future callers passing
  // animated radii (e.g. shockwaves).
  const halfCssQ = sprite.width / dpr / 2;
  const scale = radius / rQ;
  const halfCss = halfCssQ * scale;
  const prev = ctx.globalAlpha;
  if (alpha !== 1) ctx.globalAlpha = prev * alpha;
  ctx.drawImage(sprite, x - halfCss, y - halfCss, halfCss * 2, halfCss * 2);
  if (alpha !== 1) ctx.globalAlpha = prev;
}

/**
 * Drop the entire cache. Currently unused (none of our pre-cached
 * shapes use theme-dependent colors), but exported for the future
 * case where we extend caching to themed colors and need to flush
 * on a theme swap.
 */
export function clearGlowSprites(): void {
  cache.clear();
}
