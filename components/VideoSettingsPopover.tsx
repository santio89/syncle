/**
 * Consolidated "Video" settings control.
 *
 * Replaces the four separate tiles (FPS lock / Quality / View / Shape)
 * that used to live side-by-side in the StartCard, HUD, lobby settings
 * modal, and in-match HealthPanel. Those four are all PURELY VISUAL
 * knobs (no gameplay impact, no multiplayer sync), so collapsing them
 * into a single "VIDEO" trigger frees up a lot of surface area in the
 * settings grids while keeping every sub-setting one click away.
 *
 * ------------------------------------------------------------------
 * Trigger variants
 * ------------------------------------------------------------------
 *
 * - `"card"` - the two-row rectangular tile used in the pre-match
 *   StartCard (solo) and `PlayerSettingsModal` (multi lobby). Matches
 *   the dressing of the other tiles in those grids exactly (same
 *   border, padding, caption size, value chip) so the grid still
 *   reads as a uniform block.
 *
 * - `"chip"` - the compact horizontal row used in the in-match
 *   right-rail settings stack (solo `HUD` and multi `HealthPanel`).
 *   Matches the dressing of the other HUD chips exactly (one row,
 *   left caption + sub-label, right value). Takes an optional
 *   `fps` prop so the chip can still surface the live frame-rate
 *   readout the old FPS-lock tile showed - hiding all four knobs
 *   behind one button shouldn't cost the player that signal.
 *
 * ------------------------------------------------------------------
 * Popover panel
 * ------------------------------------------------------------------
 *
 * The panel renders through a React portal to `document.body` so
 * it's never clipped by a parent with `overflow: hidden` or a
 * CSS `transform` (which would re-root `position: fixed`). Opens
 * with a fade + tiny scale lift to match `PlayerSettingsModal` /
 * `LeaveConfirmModal` - all three floating surfaces in the app
 * now share one motion vocabulary.
 *
 * Dismiss triggers (any of):
 *   - Click outside the panel and outside the trigger button
 *   - Escape key
 *   - Click the ✕ button in the panel header
 *   - Click the trigger again (toggle)
 *
 * Keyboard: the panel is focus-trapped informally - Escape closes,
 * tab navigation walks through the 4 inner tiles. No explicit focus
 * loop (the content is small enough that a tab-out isn't a real UX
 * problem; same call the existing lobby settings modal makes).
 *
 * ------------------------------------------------------------------
 * Anchoring
 * ------------------------------------------------------------------
 *
 * The panel anchors to the trigger's `getBoundingClientRect()`:
 *   - Horizontally: right-aligned with the trigger, clamped inside
 *     the viewport with an 8 px margin. This keeps the panel from
 *     overflowing off the right edge on wide HUD layouts and off
 *     the left edge on narrow StartCard grids.
 *   - Vertically: prefers below (`rect.bottom + 8`). If there isn't
 *     enough room below, flips to above (`rect.top - panelH - 8`).
 *     The flip is computed once at open time - no live re-anchor on
 *     scroll because the HUD doesn't scroll and the StartCard scroll
 *     container closes the popover when dragged (outside click).
 */

"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { FpsLock, NoteShape, PerspectiveMode, RenderQuality } from "@/lib/game/settings";

export interface VideoSettingsPopoverProps {
  fpsLock: FpsLock;
  onCycleFpsLock: () => void;
  quality: RenderQuality;
  onCycleQuality: () => void;
  perspectiveMode: PerspectiveMode;
  onCyclePerspectiveMode: () => void;
  noteShape: NoteShape;
  onCycleNoteShape: () => void;
  /**
   * Trigger dressing - see the file header. `"card"` for the
   * pre-match grids, `"chip"` for the in-match right-rail stack.
   */
  variant: "card" | "chip";
  /**
   * Live FPS readout. Only consumed by the `"chip"` variant (HUD),
   * where the old standalone FPS-lock tile surfaced the live frame
   * rate under the caption. Ignored in `"card"` variant (pre-match
   * grids don't show a live FPS meter because nothing's rendering
   * on the canvas yet).
   */
  fps?: number;
  /**
   * Extra classes appended to the trigger button. Primarily used by
   * the StartCard to force the card trigger onto a `sm:col-span-2`
   * row so the VIDEO tile spans the full width of the 2-col settings
   * grid (giving it visual prominence as a gateway to four
   * sub-settings). Optional - defaults to empty. Panel classes are
   * never affected by this prop.
   */
  className?: string;
}

/**
 * Approximate rendered height of the popover panel. Used only to
 * decide whether to open above or below the trigger when below would
 * clip against the viewport bottom. An over-estimate is safe - worst
 * case we flip early and open above with 8 px of extra headroom.
 */
const PANEL_ESTIMATED_H = 240;
const PANEL_WIDTH = 320;
const VIEWPORT_PAD = 8;

/** True when any of the 4 sub-settings is on a non-default value. */
function anyNonDefault(
  fpsLock: FpsLock,
  quality: RenderQuality,
  perspectiveMode: PerspectiveMode,
  noteShape: NoteShape,
): boolean {
  return (
    fpsLock !== null ||
    quality !== "high" ||
    perspectiveMode !== "2d" ||
    noteShape !== "rect"
  );
}

export function VideoSettingsPopover(props: VideoSettingsPopoverProps) {
  const {
    fpsLock,
    onCycleFpsLock,
    quality,
    onCycleQuality,
    perspectiveMode,
    onCyclePerspectiveMode,
    noteShape,
    onCycleNoteShape,
    variant,
    fps,
    className,
  } = props;

  // Render-after-mount gate + entry-transition gate. Same two-frame
  // pattern `PlayerSettingsModal` uses: mount invisible, flip to
  // visible on the next microtask so the transition has a start
  // state to animate from. Exit is handled the inverse way (flip
  // visible → false, then unmount after the transition duration).
  // We derive the "is open" signal from `mounted` alone (the trigger
  // button's aria-expanded + toggle() both read it) rather than
  // tracking a separate `open` boolean - `mounted` is true from the
  // moment the panel exists in the DOM (even while the fade-in is
  // still running) and false again only after the 220 ms exit
  // transition finishes, which matches the behaviour we want for
  // "is the popover currently showing?" at every read site.
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState<{
    top: number;
    left: number;
    origin: "top" | "bottom";
  } | null>(null);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Portal target is only set on the client after mount - `document`
  // doesn't exist during SSR so we can't look it up at module scope.
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);

  const headingId = useId();

  useEffect(() => {
    if (typeof document !== "undefined") setPortalHost(document.body);
  }, []);

  const close = useCallback(() => {
    setVisible(false);
    // Match the 220 ms transition duration used below. unmount after
    // the exit animation so DOM stays consistent with what the user
    // sees on screen.
    window.setTimeout(() => setMounted(false), 220);
  }, []);

  const openPopover = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    // Prefer below; flip to above if below would clip and above has
    // more room.
    const openAbove =
      spaceBelow < PANEL_ESTIMATED_H + VIEWPORT_PAD &&
      spaceAbove > spaceBelow;
    const top = openAbove
      ? Math.max(VIEWPORT_PAD, rect.top - PANEL_ESTIMATED_H - 8)
      : rect.bottom + 8;
    // Right-align to the trigger, clamp inside the viewport.
    const rawLeft = rect.right - PANEL_WIDTH;
    const maxLeft = window.innerWidth - PANEL_WIDTH - VIEWPORT_PAD;
    const left = Math.max(VIEWPORT_PAD, Math.min(rawLeft, maxLeft));
    setPosition({ top, left, origin: openAbove ? "bottom" : "top" });
    setMounted(true);
    // Two-frame entry: mount, then next frame flip visible=true so
    // the transition has a distinct from/to to interpolate.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setVisible(true));
    });
  }, []);

  const toggle = useCallback(() => {
    if (mounted) close();
    else openPopover();
  }, [mounted, close, openPopover]);

  // Outside-click + Esc dismiss.
  useEffect(() => {
    if (!mounted) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    }
    function onPointerDown(e: MouseEvent) {
      const target = e.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      close();
    }
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onPointerDown, true);
    };
  }, [mounted, close]);

  // Re-anchor on window resize / scroll while open - the in-match HUD
  // doesn't scroll but the StartCard container can on small viewports,
  // and the multi lobby's PlayerSettingsModal has its own scrollable
  // body. Keeps the panel glued to the trigger instead of drifting.
  useEffect(() => {
    if (!mounted) return;
    function reanchor() {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      const openAbove =
        spaceBelow < PANEL_ESTIMATED_H + VIEWPORT_PAD &&
        spaceAbove > spaceBelow;
      const top = openAbove
        ? Math.max(VIEWPORT_PAD, rect.top - PANEL_ESTIMATED_H - 8)
        : rect.bottom + 8;
      const rawLeft = rect.right - PANEL_WIDTH;
      const maxLeft = window.innerWidth - PANEL_WIDTH - VIEWPORT_PAD;
      const left = Math.max(VIEWPORT_PAD, Math.min(rawLeft, maxLeft));
      setPosition({ top, left, origin: openAbove ? "bottom" : "top" });
    }
    window.addEventListener("resize", reanchor);
    window.addEventListener("scroll", reanchor, true);
    return () => {
      window.removeEventListener("resize", reanchor);
      window.removeEventListener("scroll", reanchor, true);
    };
  }, [mounted]);

  const highlighted = anyNonDefault(fpsLock, quality, perspectiveMode, noteShape);

  // --- TRIGGER ---------------------------------------------------
  const trigger = variant === "card" ? (
    <button
      ref={triggerRef}
      type="button"
      onClick={toggle}
      className={`flex cursor-pointer flex-col justify-between gap-1 border-2 border-bone-50/30 bg-ink-900/50 px-3 py-2 text-left${className ? ` ${className}` : ""}`}
      data-tooltip="FPS lock, quality, view, shape"
      aria-label="Open video settings"
      aria-haspopup="dialog"
      aria-expanded={mounted}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[10.5px] uppercase tracking-widest text-bone-50/70">
          Video
        </span>
        <span
          aria-hidden
          className={`font-mono text-[10px] uppercase tracking-widest transition-colors ${
            highlighted ? "text-accent" : "text-bone-50/60"
          }`}
        >
          {mounted ? "CLOSE" : "OPEN"}
        </span>
      </div>
      <span className="font-mono text-[9.5px] text-bone-50/40">
        fps · quality · view · shape
      </span>
    </button>
  ) : (
    <button
      ref={triggerRef}
      type="button"
      onClick={toggle}
      // `w-full` so the chip spans the full width of the in-match
      // right-rail stack and visually matches its siblings (Metronome
      // / Feedback `<label>` rows + the Volume `<div>`, all of which
      // are block-level and fill the rail by default). Without it,
      // the button shrinks to content - which left a visibly narrower
      // VIDEO chip floating on the left while every other row in the
      // same column stretched edge-to-edge, breaking the rail's
      // grid rhythm. The `text-left` keeps caption + sub-label
      // anchored against the left edge once we widen.
      className={`pointer-events-auto flex w-full cursor-pointer items-center justify-between gap-2 border border-bone-50/30 bg-ink-900/40 px-2.5 py-2 text-left${className ? ` ${className}` : ""}`}
      data-tooltip="FPS lock, quality, view, shape"
      aria-label="Open video settings"
      aria-haspopup="dialog"
      aria-expanded={mounted}
    >
      <span className="flex flex-col">
        <span className="font-mono text-[9.2px] uppercase tracking-widest text-bone-50/70 sm:text-[10.2px]">
          Video
        </span>
        <span className="font-mono text-[9.2px] tabular-nums tracking-widest text-bone-50/40">
          {fps != null ? `${fps || "-"}fps` : "display settings"}
        </span>
      </span>
      <span
        aria-hidden
        className={`font-mono text-[9.2px] uppercase tracking-widest tabular-nums transition-colors ${
          highlighted ? "text-accent" : "text-bone-50/60"
        }`}
      >
        {mounted ? "CLOSE" : "OPEN"}
      </span>
    </button>
  );

  // --- PANEL -----------------------------------------------------
  const panel = mounted && position && portalHost
    ? createPortal(
        <div
          ref={panelRef}
          className={`fixed z-[60] will-change-[opacity,transform] transition-[opacity,transform] duration-[220ms] ease-out ${
            visible ? "opacity-100 scale-100 translate-y-0" : "opacity-0 scale-[0.97] translate-y-1"
          }`}
          style={{
            top: position.top,
            left: position.left,
            width: PANEL_WIDTH,
            transformOrigin: position.origin === "bottom" ? "bottom right" : "top right",
          }}
          role="dialog"
          aria-modal="false"
          aria-labelledby={headingId}
        >
          {/* Fully-opaque surface. We deliberately do NOT add the
              `.brut-card` utility here even though every other
              floating surface in the app uses it - `.brut-card` sets
              its background as a SHORTHAND (`background: rgb(var(--surface) / 0.6)`)
              defined LATER in `globals.css` than `@tailwind utilities`,
              which means it silently wins the cascade against any
              `bg-*` Tailwind utility we'd add and pins the panel to
              60 % alpha no matter what. On top of that, `.brut-card`
              also runs `backdrop-filter: blur(22px) saturate(120%)`
              which actively samples and blurs whatever is painted
              behind it - including the live note canvas and the
              HUD's "FEEDBACK" / combo / lyric overlays - producing
              the noisy / glitchy bleed-through users flagged on the
              Video popover specifically (other brut-cards sit over
              calmer page backgrounds, so the same surface treatment
              reads fine there).
              Fix: drop `brut-card`, keep the solid `bg-ink-900`
              (Tailwind utility, no shorthand fight to lose), and
              re-add the brutalist drop shadow via inline style so
              the panel still has the same offset-block depth as
              `LeaveConfirmModal` / `PlayerSettingsModal` etc.
              `rgb(var(--shadow))` is theme-aware (bone-white shadow
              in dark mode, near-black ink in light mode) - same
              token `.brut-card` itself uses for its shadow, so
              there's no visual divergence from the rest of the
              floating-surface family. */}
          <div
            className="flex flex-col gap-2 border-2 border-bone-50/30 bg-ink-900 p-3"
            style={{ boxShadow: "6px 6px 0 0 rgb(var(--shadow))" }}
          >
            <div className="flex items-baseline justify-between gap-3">
              <p
                id={headingId}
                className="font-mono text-[10px] uppercase tracking-[0.4em] text-accent"
              >
                ░ Video
              </p>
              <button
                type="button"
                onClick={close}
                className="font-mono text-[12px] leading-none text-bone-50/55 transition-colors hover:text-accent"
                aria-label="Close video settings"
                data-tooltip="Close (ESC)"
              >
                ✕
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2">
              {/* FPS lock tile */}
              <button
                type="button"
                onClick={onCycleFpsLock}
                className="flex cursor-pointer flex-col justify-between gap-1 border-2 border-bone-50/30 bg-ink-900/50 px-3 py-2 text-left"
                data-tooltip={
                  fpsLock == null
                    ? "Frame-rate uncapped - cap to 30 / 60 FPS to save battery"
                    : fpsLock === 30
                      ? "Frame-rate capped at 30 FPS - saves battery on laptops"
                      : "Frame-rate capped at 60 FPS - matches a typical monitor refresh"
                }
                aria-label="Cycle render FPS lock"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="font-mono text-[10.5px] uppercase tracking-widest text-bone-50/70">
                    FPS lock
                  </span>
                  <span
                    aria-hidden
                    className={`font-mono text-[10px] uppercase tracking-widest transition-colors ${
                      fpsLock == null ? "text-bone-50/60" : "text-accent"
                    }`}
                  >
                    {fpsLock == null ? "OFF" : fpsLock}
                  </span>
                </div>
                <span className="font-mono text-[9.5px] text-bone-50/40">
                  off · 30 · 60
                </span>
              </button>

              {/* Quality tile */}
              <button
                type="button"
                onClick={onCycleQuality}
                className="flex cursor-pointer flex-col justify-between gap-1 border-2 border-bone-50/30 bg-ink-900/50 px-3 py-2 text-left"
                data-tooltip={
                  quality === "high"
                    ? "HIGH · full VFX: shadow glows, particles, shockwaves, milestone vignette"
                    : "PERFORMANCE · VFX disabled for steady frame rate on weaker GPUs"
                }
                aria-label="Cycle render quality preset"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="font-mono text-[10.5px] uppercase tracking-widest text-bone-50/70">
                    Quality
                  </span>
                  <span
                    aria-hidden
                    className={`font-mono text-[10px] uppercase tracking-widest transition-colors ${
                      quality === "high" ? "text-bone-50/60" : "text-accent"
                    }`}
                  >
                    {quality === "high" ? "HIGH" : "PERF"}
                  </span>
                </div>
                <span className="font-mono text-[9.5px] text-bone-50/40">
                  full vfx · no vfx
                </span>
              </button>

              {/* View / perspective tile */}
              <button
                type="button"
                onClick={onCyclePerspectiveMode}
                className="flex cursor-pointer flex-col justify-between gap-1 border-2 border-bone-50/30 bg-ink-900/50 px-3 py-2 text-left"
                data-tooltip={
                  perspectiveMode === "3d"
                    ? "3D · Guitar Hero-style perspective highway, notes scale with depth"
                    : "2D · flat osu!-style lanes, constant note size, parallel rails"
                }
                aria-label="Cycle playfield perspective mode"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="font-mono text-[10.5px] uppercase tracking-widest text-bone-50/70">
                    View
                  </span>
                  <span
                    aria-hidden
                    className={`font-mono text-[10px] uppercase tracking-widest transition-colors ${
                      perspectiveMode === "3d" ? "text-accent" : "text-bone-50/60"
                    }`}
                  >
                    {perspectiveMode === "3d" ? "3D" : "2D"}
                  </span>
                </div>
                <span className="font-mono text-[9.5px] text-bone-50/40">
                  fret perspective
                </span>
              </button>

              {/* Note shape tile */}
              <button
                type="button"
                onClick={onCycleNoteShape}
                className="flex cursor-pointer flex-col justify-between gap-1 border-2 border-bone-50/30 bg-ink-900/50 px-3 py-2 text-left"
                data-tooltip={
                  noteShape === "rect"
                    ? "Rectangles · brutalist tiles, match the lane (default)"
                    : "Circles · classic osu-style discs"
                }
                aria-label="Cycle note shape"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="font-mono text-[10.5px] uppercase tracking-widest text-bone-50/70">
                    Shape
                  </span>
                  <span
                    aria-hidden
                    className={`font-mono text-[10px] uppercase tracking-widest transition-colors ${
                      noteShape === "circle" ? "text-accent" : "text-bone-50/60"
                    }`}
                  >
                    {noteShape === "circle" ? "CIRC" : "RECT"}
                  </span>
                </div>
                <span className="font-mono text-[9.5px] text-bone-50/40">
                  note style
                </span>
              </button>
            </div>
          </div>
        </div>,
        portalHost,
      )
    : null;

  return (
    <>
      {trigger}
      {panel}
    </>
  );
}
