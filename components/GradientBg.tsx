"use client";

import { useEffect, useRef } from "react";

/**
 * Soft animated gradient blobs anchored to specific viewport positions.
 *
 * Unlike a drifting gradient that washes the whole page, each blob orbits a
 * fixed anchor with a small sine amplitude — so the glow stays roughly
 * "behind" specific UI elements (the play button area, the cards row) and
 * the rest of the page stays deep black.
 */
type Blob = {
  /** Anchor as a fraction of canvas size (0..1). */
  cx: number;
  cy: number;
  /** Sine amplitude as a fraction of canvas size. */
  ax: number;
  ay: number;
  /** Oscillation frequency in radians/sec. */
  freq: number;
  phase: number;
  /** Radius as a fraction of max(width, height). */
  r: number;
  hue: string;
  alpha: number;
};

// Anchor coordinates roughly correspond to the home-page layout:
//   right-center → play button area
//   bottom-left/right → today's track + stats cards
const BLOBS: Blob[] = [
  // Big soft glow behind the play button (right side, vertically centered).
  {
    cx: 0.78, cy: 0.42,
    ax: 0.025, ay: 0.02,
    freq: 0.35, phase: 0.0,
    r: 0.28,
    hue: "61, 169, 255",
    alpha: 0.16,
  },
  // Today's track card (lower-left).
  {
    cx: 0.32, cy: 0.82,
    ax: 0.03, ay: 0.018,
    freq: 0.27, phase: 1.4,
    r: 0.22,
    hue: "61, 169, 255",
    alpha: 0.10,
  },
  // Stats card (lower-right).
  {
    cx: 0.78, cy: 0.84,
    ax: 0.02, ay: 0.022,
    freq: 0.32, phase: 2.9,
    r: 0.16,
    hue: "100, 90, 200",
    alpha: 0.06,
  },
  // Tiny accent behind the "SYNCLE." tagline (upper-left).
  {
    cx: 0.22, cy: 0.32,
    ax: 0.015, ay: 0.012,
    freq: 0.22, phase: 0.7,
    r: 0.18,
    hue: "61, 169, 255",
    alpha: 0.05,
  },
];

export function GradientBg() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let width = 0;
    let height = 0;
    let dpr = Math.min(window.devicePixelRatio || 1, 2);

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    resize();
    window.addEventListener("resize", resize);

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const t0 = performance.now();

    // The gradient is CSS-blurred 48px so the eye can't tell it from 30fps.
    // Throttling halves background CPU on idle and lets the play page feel
    // even snappier when the home tab is left open in another window.
    const TARGET_FPS = reduce ? 1 : 30;
    const FRAME_MS = 1000 / TARGET_FPS;
    let lastDraw = 0;

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - lastDraw < FRAME_MS) return;
      lastDraw = now;

      const t = (now - t0) / 1000; // seconds
      ctx.clearRect(0, 0, width, height);

      for (const b of BLOBS) {
        const offX = reduce ? 0 : Math.sin(t * b.freq + b.phase) * b.ax;
        const offY = reduce ? 0 : Math.cos(t * b.freq + b.phase) * b.ay;
        const cx = (b.cx + offX) * width;
        const cy = (b.cy + offY) * height;
        const radius = b.r * Math.max(width, height);

        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
        grad.addColorStop(0, `rgba(${b.hue}, ${b.alpha})`);
        grad.addColorStop(1, `rgba(${b.hue}, 0)`);
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, width, height);
      }
    };

    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      <canvas
        ref={canvasRef}
        className="h-full w-full"
        style={{ filter: "blur(48px)" }}
      />
    </div>
  );
}
