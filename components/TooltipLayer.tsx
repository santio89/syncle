"use client";

/**
 * Single-mount tooltip system. Drop one `<TooltipLayer />` into the
 * root layout and every element in the app gets a custom-styled
 * tooltip on hover / focus, replacing the OS-default `title` bubble
 * (which is unstyleable, slow to appear, and visually inconsistent
 * across browsers).
 *
 * Two trigger sources, in priority order:
 *
 *   1. `data-tooltip="some text"` — preferred for new code; the value
 *      is the canonical source so React re-renders never lose it.
 *   2. `title="some text"` — back-compat for the existing call sites
 *      that already use the native attribute. On first hover we
 *      MOVE the title's value into our own WeakMap and STRIP the
 *      attribute from the DOM so the browser never gets a chance to
 *      pop its own bubble. If React re-renders the element with a
 *      fresh `title` prop, we strip again on the next hover. The
 *      WeakMap entry is GC'd automatically when the element unmounts.
 *
 * Why event delegation instead of a wrapper component?
 *   - Zero per-element runtime cost — we wire 4 listeners total.
 *   - Works with arbitrary children (third-party libs, raw HTML)
 *     without forcing every call site to import a `<Tooltip>`.
 *   - Migrating the codebase is just "add data-tooltip" or "leave
 *     title alone" — no JSX restructuring.
 *
 * Touch devices skip the whole thing: `(hover: none)` matchMedia
 * suppresses tooltips entirely so they don't conflict with native
 * tap behavior on mobile (where there's no hover state to land on
 * and the tooltip would only trigger on long-press, badly).
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Placement = "top" | "bottom";

interface TooltipState {
  text: string;
  /** Anchor rect (viewport coords) — used to compute final position. */
  rect: DOMRect;
  placement: Placement;
}

const SHOW_DELAY_MS = 320;
const HIDE_DELAY_MS = 80;
/** Min vertical breathing room between the tooltip nub and the trigger. */
const ANCHOR_GAP_PX = 8;
/**
 * If the trigger sits within this many px of the viewport top, we flip
 * the tooltip below it. Mirror the same threshold for the bottom edge.
 */
const EDGE_FLIP_PX = 80;

export function TooltipLayer() {
  const [state, setState] = useState<TooltipState | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);

  // Measured tooltip box, used for clamping inside the viewport so a
  // long tooltip near the right edge doesn't get clipped.
  const [boxSize, setBoxSize] = useState<{ w: number; h: number } | null>(null);

  // Refs survive across renders without invalidating effects.
  const showTimerRef = useRef<number | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  // Tracks the trigger element currently being shown for so we can
  // skip duplicate work when the pointer wanders inside it.
  const currentTargetRef = useRef<Element | null>(null);
  // Stripped `title` values keyed by the element they were stolen
  // from. WeakMap → no manual cleanup, GC follows the element.
  const titleCacheRef = useRef<WeakMap<Element, string>>(new WeakMap());

  /* -----------------------------------------------------------------
   * Measure the rendered tooltip on every state change so we can clamp
   * it inside the viewport and center it horizontally without overflow.
   * useLayoutEffect → runs before paint, so the user never sees an
   * un-clamped frame. ---------------------------------------------- */
  useLayoutEffect(() => {
    if (!state || !tooltipRef.current) {
      setBoxSize(null);
      return;
    }
    const r = tooltipRef.current.getBoundingClientRect();
    // Only update if size meaningfully changed — prevents a render loop
    // when the same tooltip text re-measures to the same dimensions.
    setBoxSize((prev) =>
      prev && Math.abs(prev.w - r.width) < 0.5 && Math.abs(prev.h - r.height) < 0.5
        ? prev
        : { w: r.width, h: r.height },
    );
  }, [state]);

  /* -----------------------------------------------------------------
   * Document-wide event delegation. One set of listeners, lifetime
   * = component lifetime. Leaves the DOM untouched on touch-only
   * devices (mobile / tablet). --------------------------------------- */
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.matchMedia?.("(hover: none)").matches) return;

    /**
     * Walk up the DOM tree from `start` looking for the closest
     * ancestor that owns a tooltip. Returns the element and the
     * resolved text, or null if none of the ancestors qualify.
     */
    const findTooltipTarget = (
      start: Element | null,
    ): { el: Element; text: string } | null => {
      let el: Element | null = start;
      while (el && el !== document.body) {
        const dt = el.getAttribute("data-tooltip");
        if (dt) return { el, text: dt };
        const cached = titleCacheRef.current.get(el);
        if (cached) return { el, text: cached };
        const t = el.getAttribute("title");
        if (t) {
          // Steal the title so the browser never shows its own
          // bubble; remember the value for subsequent hovers.
          titleCacheRef.current.set(el, t);
          el.removeAttribute("title");
          return { el, text: t };
        }
        el = el.parentElement;
      }
      return null;
    };

    const showFor = (target: Element, text: string) => {
      currentTargetRef.current = target;
      const rect = target.getBoundingClientRect();
      // Prefer above; flip below when the trigger hugs the viewport top.
      const placement: Placement = rect.top < EDGE_FLIP_PX ? "bottom" : "top";
      setState({ text, rect, placement });
    };

    const hide = () => {
      currentTargetRef.current = null;
      setState(null);
    };

    const clearShowTimer = () => {
      if (showTimerRef.current != null) {
        window.clearTimeout(showTimerRef.current);
        showTimerRef.current = null;
      }
    };
    const clearHideTimer = () => {
      if (hideTimerRef.current != null) {
        window.clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    };

    const onPointerOver = (e: PointerEvent) => {
      // Touch / pen events get filtered by hover:none above, but be
      // defensive anyway — some hybrid devices report "mouse" for
      // touch interactions.
      if (e.pointerType !== "mouse" && e.pointerType !== "pen") return;
      const found = findTooltipTarget(e.target as Element | null);
      if (!found) return;
      // Pointer wandered into a child of the same trigger — keep
      // current tooltip up, don't restart the show timer.
      if (currentTargetRef.current === found.el && state) return;
      clearHideTimer();
      clearShowTimer();
      showTimerRef.current = window.setTimeout(() => {
        showTimerRef.current = null;
        showFor(found.el, found.text);
      }, SHOW_DELAY_MS);
    };

    const onPointerOut = (e: PointerEvent) => {
      // Don't dismiss if the pointer is still inside the same trigger.
      const related = e.relatedTarget as Element | null;
      const found = related ? findTooltipTarget(related) : null;
      if (
        found &&
        (found.el === currentTargetRef.current || found.el === e.target)
      ) {
        return;
      }
      clearShowTimer();
      clearHideTimer();
      hideTimerRef.current = window.setTimeout(() => {
        hideTimerRef.current = null;
        hide();
      }, HIDE_DELAY_MS);
    };

    const onFocusIn = (e: FocusEvent) => {
      // Keyboard focus → show immediately (no hover delay), since the
      // user is asking for the affordance explicitly via Tab.
      const found = findTooltipTarget(e.target as Element | null);
      if (!found) return;
      clearShowTimer();
      clearHideTimer();
      showFor(found.el, found.text);
    };

    const onFocusOut = () => {
      clearShowTimer();
      clearHideTimer();
      hide();
    };

    const onScroll = () => hide();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        clearShowTimer();
        hide();
      }
    };
    const onPointerDownGlobal = () => {
      // Clicking anywhere dismisses — feels right because click =
      // commitment, tooltip = ambient hint.
      clearShowTimer();
      hide();
    };

    document.addEventListener("pointerover", onPointerOver);
    document.addEventListener("pointerout", onPointerOut);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDownGlobal);
    window.addEventListener("scroll", onScroll, {
      passive: true,
      capture: true,
    });

    return () => {
      document.removeEventListener("pointerover", onPointerOver);
      document.removeEventListener("pointerout", onPointerOut);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDownGlobal);
      window.removeEventListener("scroll", onScroll, { capture: true });
      clearShowTimer();
      clearHideTimer();
    };
    // We intentionally exclude `state` from deps — the listeners
    // capture state via the closure once, and we re-attach only on
    // mount/unmount. The duplicate-trigger guard inside `onPointerOver`
    // works because we read `currentTargetRef.current` (always fresh).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!state || typeof document === "undefined") return null;

  // Compute final top-left in viewport coords. We do horizontal centering
  // via an inline transform (no measurement required) and vertical
  // alignment via top/left (no transform on the Y axis). When we have a
  // measured boxSize we additionally clamp left so the bubble can't
  // overflow either side of the viewport.
  const { rect, placement, text } = state;
  const cx = rect.left + rect.width / 2;
  const top =
    placement === "top"
      ? rect.top - ANCHOR_GAP_PX
      : rect.bottom + ANCHOR_GAP_PX;

  let left = cx;
  let translateX = "-50%";
  if (boxSize) {
    const half = boxSize.w / 2;
    const margin = 8;
    if (cx - half < margin) {
      left = margin;
      translateX = "0";
    } else if (cx + half > window.innerWidth - margin) {
      left = window.innerWidth - margin;
      translateX = "-100%";
    }
  }

  const translateY = placement === "top" ? "-100%" : "0";

  return createPortal(
    <div
      ref={tooltipRef}
      role="tooltip"
      data-placement={placement}
      className="brut-tooltip"
      style={{
        top,
        left,
        transform: `translate(${translateX}, ${translateY})`,
      }}
    >
      {text}
    </div>,
    document.body,
  );
}
