"use client";

/**
 * ScrollStrip
 * -----------
 * Horizontal, Swiper-style scrollable row. Behaves as:
 *
 *   - Wide enough container → children fill the row (no overflow,
 *     nothing to scroll, no drag activates). The picker collapses
 *     gracefully into a static-looking strip.
 *   - Narrow container → children overflow the right edge, the strip
 *     becomes scrollable, AND a left-button drag pans it (matches the
 *     "swiper" pattern users expect from carousels). Touch swipes
 *     work natively via the underlying `overflow-x: auto`.
 *
 * Drag detection:
 *   - We don't `setPointerCapture` until the pointer has moved past a
 *     small threshold (5 px). That keeps a plain click on a child
 *     button working — pointers that never exceed the threshold fall
 *     through as a normal `click`. Once we DO start dragging, we
 *     suppress the next `click` event (capture phase) so dropping the
 *     mouse on top of a child doesn't accidentally activate it after
 *     a flick scroll.
 *   - Drag math is `scrollLeft = startScroll - dx`, computed against
 *     the pointer down baseline so a slow re-grab during the same
 *     gesture stays snappy and doesn't drift.
 *
 * The visible scrollbar is hidden via the `.scroll-strip` CSS utility
 * (in `globals.css`) — the strip is short and the row of buttons
 * already communicates "more to the side" via overflow / cursor.
 *
 * Generic enough to wrap any `<button>`/`<div>` children — the only
 * structural assumption is `display: flex` (added here) so children
 * lay out in a row.
 */

import { useEffect, useRef } from "react";

const DRAG_THRESHOLD_PX = 5;

interface Props {
  children: React.ReactNode;
  /** Tailwind gap class for the inner flex row (e.g. `gap-1`, `gap-2`). */
  gapClass?: string;
  /** Extra Tailwind classes piped onto the scroll container. */
  className?: string;
  /** Aria-label for the scroll region (defaults to undefined — let
   * the consumer decide whether the strip is meaningful enough to
   * announce). */
  ariaLabel?: string;
}

export default function ScrollStrip({
  children,
  gapClass = "gap-1",
  className = "",
  ariaLabel,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  // All drag state lives in a ref — re-rendering on each pointer move
  // would be wasteful (and would cause input lag at 120 Hz polling).
  const dragRef = useRef({
    active: false,
    startX: 0,
    startScroll: 0,
    moved: 0,
    pointerId: -1,
    captured: false,
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Capture-phase click suppressor — fires BEFORE any child button's
    // own click handler, so we can short-circuit a `click` that was
    // really the tail of a drag gesture (mouse released while still
    // hovering a tier button after a flick). Threshold is the same as
    // `DRAG_THRESHOLD_PX` so the rule is consistent: anything that
    // crossed the threshold counts as a drag, not a click.
    const onClickCapture = (e: MouseEvent) => {
      if (dragRef.current.moved > DRAG_THRESHOLD_PX) {
        e.stopPropagation();
        e.preventDefault();
      }
    };
    el.addEventListener("click", onClickCapture, true);
    return () => el.removeEventListener("click", onClickCapture, true);
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Mouse: only react to left-button drags. Touch / pen always
    // qualify (they have no concept of "right-click") — skipping them
    // would break swipe-to-scroll on mobile.
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const el = ref.current;
    if (!el) return;
    dragRef.current = {
      active: true,
      startX: e.clientX,
      startScroll: el.scrollLeft,
      moved: 0,
      pointerId: e.pointerId,
      captured: false,
    };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d.active || d.pointerId !== e.pointerId) return;
    const el = ref.current;
    if (!el) return;
    const dx = e.clientX - d.startX;
    const absDx = Math.abs(dx);
    if (absDx > d.moved) d.moved = absDx;
    if (d.moved > DRAG_THRESHOLD_PX) {
      // Lazy capture: only steal the pointer once we've decided this
      // gesture is a drag. Lets a stationary press-and-release fall
      // through as a regular click on the child button.
      if (!d.captured) {
        try {
          el.setPointerCapture(e.pointerId);
          d.captured = true;
        } catch {
          /* setPointerCapture can throw under racey unmount. */
        }
      }
      el.scrollLeft = d.startScroll - dx;
    }
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (d.pointerId !== e.pointerId) return;
    const el = ref.current;
    if (el && d.captured) {
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* same: releasePointerCapture is best-effort. */
      }
    }
    d.active = false;
    d.captured = false;
    // Keep `moved` set for the SAME tick so the capture-phase click
    // suppressor above can read it; reset on the next microtask so
    // the NEXT click (a real one) goes through. Without this delay
    // the suppressor never fires and a drag-then-release on a child
    // button still triggers its onClick.
    queueMicrotask(() => {
      // Belt-and-braces: only reset if no new drag started in the
      // meantime (a fast double-grab would otherwise zero out the
      // in-flight drag's accumulated movement).
      if (!dragRef.current.active) dragRef.current.moved = 0;
    });
  };

  return (
    <div
      ref={ref}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      role={ariaLabel ? "region" : undefined}
      aria-label={ariaLabel}
      className={`scroll-strip flex cursor-grab select-none active:cursor-grabbing ${gapClass} ${className}`}
    >
      {children}
    </div>
  );
}
