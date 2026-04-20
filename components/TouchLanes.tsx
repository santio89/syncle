"use client";

import { useCallback, useRef, useState } from "react";

/**
 * On-screen lane buttons. Used by BOTH single-player (`Game.tsx`) and
 * multiplayer (`MultiGame.tsx`); kept in one shared file so behaviour
 * stays in lockstep across both modes (the previous duplicated copies
 * had to be patched twice for every fix and were drifting).
 *
 * Behaviour contract:
 *   - Four full-bleed columns over the bottom two-thirds of the canvas,
 *     directly under the lane gates.
 *   - Pointer Events cover mouse + touch + pen, so the same component
 *     handles desktop click, phone tap, stylus, and hybrid touchscreen
 *     laptops. `pressLane` / `releaseLane` are the SAME callbacks the
 *     keyboard handler invokes — i.e. clicking a column is exactly
 *     equivalent to a keypress, including hold-note semantics.
 *
 * Why the per-pointer lane map (`pointerLaneRef`) — multi-touch correctness:
 *   We track which lane each pointerId pressed. On pointerup/cancel/leave
 *   we look the lane back up by pointerId and release THAT specific lane.
 *   Without the map, a finger that drifts across columns or a browser that
 *   loses pointer capture would release the wrong lane, leaving a hold
 *   note stranded as "still held" forever. The map is also what guarantees
 *   that touching lane 1 with one finger and lane 3 with another only
 *   highlights / releases each lane independently — the fix for the
 *   "all lanes light up at once" bug some browsers exhibited with the
 *   previous CSS `:active`-driven highlight (multi-touch + WebKit
 *   sometimes propagates `:active` across siblings until every finger
 *   lifts). Driving the highlight from React state keyed on the per-lane
 *   pointer set keeps it deterministic.
 *
 * Why `<div role="button">` instead of `<button>`:
 *   Native buttons receive focus on press, which (a) draws a system focus
 *   ring on top of the canvas, (b) means a subsequent keyboard press of
 *   space/enter would re-fire the lane, and (c) on iOS Safari sometimes
 *   leaves a sticky `:active` on a previously-tapped button until you
 *   tap somewhere else. Using a non-focusable div with `role="button"`
 *   sidesteps all three while keeping the semantic announcement for
 *   screen readers.
 *
 * Why `touchAction: "none"`:
 *   Stops the browser from claiming a finger for scroll / pinch-zoom /
 *   double-tap-to-zoom gestures during play. Without it, a fast
 *   left-to-right swipe across the lanes registers as a horizontal
 *   page swipe instead of four discrete taps.
 *
 * Why `WebkitTapHighlightColor: transparent` + `outline: none`:
 *   Suppresses the iOS Safari grey tap rectangle and any UA focus
 *   outline. The visible highlight is entirely React-controlled below,
 *   so the system overlays would just fight us.
 */
export default function TouchLanes({
  onPress,
  onRelease,
}: {
  onPress: (lane: number) => void;
  onRelease: (lane: number) => void;
}) {
  const colors = ["#ff3b6b", "#ffd23f", "#3dff8a", "#3da9ff"];

  // Which lanes are currently held. Drives the React-controlled
  // highlight tint — replaces the old CSS `:active` approach which
  // misbehaved across siblings on multi-touch in WebKit.
  const [pressed, setPressed] = useState<boolean[]>([
    false,
    false,
    false,
    false,
  ]);

  // pointerId -> lane. Required for correct release semantics with
  // pointer capture: pointerup/cancel can fire on the captured element
  // even if the finger drifted into another column, so we must look up
  // the lane that pointer ORIGINALLY pressed instead of trusting the
  // event's currentTarget. Map (not Record) so we can iterate cheaply.
  const pointerLaneRef = useRef<Map<number, number>>(new Map());

  const press = useCallback(
    (lane: number, pointerId: number, target: HTMLElement) => {
      // If this pointer is already mapped (rare — repeated pointerdown
      // without an intervening up), release the old lane first to keep
      // the engine state honest.
      const prev = pointerLaneRef.current.get(pointerId);
      if (prev !== undefined && prev !== lane) {
        onRelease(prev);
        setPressed((s) => {
          if (!s[prev]) return s;
          const next = s.slice();
          next[prev] = false;
          return next;
        });
      }
      pointerLaneRef.current.set(pointerId, lane);
      try {
        target.setPointerCapture(pointerId);
      } catch {
        // Some browsers throw if capture is already held by another
        // element or if the pointer has already gone away. Capture is
        // a nice-to-have (it makes drift across columns release the
        // RIGHT lane), but we still have the pointerId map as a
        // fallback so this is non-fatal.
      }
      setPressed((s) => {
        if (s[lane]) return s;
        const next = s.slice();
        next[lane] = true;
        return next;
      });
      onPress(lane);
    },
    [onPress, onRelease],
  );

  const release = useCallback(
    (pointerId: number, target: HTMLElement | null) => {
      const lane = pointerLaneRef.current.get(pointerId);
      if (lane === undefined) return;
      pointerLaneRef.current.delete(pointerId);
      if (target) {
        try {
          if (target.hasPointerCapture(pointerId)) {
            target.releasePointerCapture(pointerId);
          }
        } catch {
          /* see comment in press() */
        }
      }
      setPressed((s) => {
        if (!s[lane]) return s;
        const next = s.slice();
        next[lane] = false;
        return next;
      });
      onRelease(lane);
    },
    [onRelease],
  );

  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-0 top-1/3 z-10 grid grid-cols-4 select-none"
      aria-hidden
    >
      {[0, 1, 2, 3].map((lane) => {
        const isDown = pressed[lane];
        return (
          <div
            key={lane}
            role="button"
            aria-label={`Lane ${lane + 1}`}
            // tabIndex omitted so the lanes never enter the keyboard
            // focus order — they're a touch / click affordance, not a
            // keyboard one (the keys D/F/J/K and arrows are the
            // keyboard contract for lane input).
            className="pointer-events-auto relative h-full w-full border-t-2"
            style={{
              touchAction: "none",
              WebkitTapHighlightColor: "transparent",
              WebkitUserSelect: "none",
              userSelect: "none",
              outline: "none",
              cursor: "pointer",
              borderTopColor: `${colors[lane]}33`,
              backgroundColor: isDown
                ? "rgba(255, 255, 255, 0.10)"
                : "transparent",
              transition: isDown ? "none" : "background-color 75ms linear",
            }}
            onPointerDown={(e) => {
              // preventDefault stops the browser from emitting the
              // synthetic mousedown after a touch (would double-fire
              // on devices that don't support pointer events natively
              // and fall back to touch + emulated mouse).
              e.preventDefault();
              e.stopPropagation();
              press(lane, e.pointerId, e.currentTarget as HTMLElement);
            }}
            onPointerUp={(e) => {
              e.preventDefault();
              e.stopPropagation();
              release(e.pointerId, e.currentTarget as HTMLElement);
            }}
            onPointerCancel={(e) => {
              // Pointer cancellations: the OS yanked the pointer away
              // (call interrupt, alert, system gesture). Treat as a
              // release so we don't leave the lane stuck "down".
              release(e.pointerId, e.currentTarget as HTMLElement);
            }}
            onPointerLeave={(e) => {
              // Fallback for the unusual case where capture failed or
              // was lost mid-press. With capture working, pointerleave
              // doesn't fire while the pointer is held over a captured
              // element. Without capture, a finger sliding off the
              // column would otherwise leave the lane stuck. Cheap
              // safety net.
              if (pointerLaneRef.current.has(e.pointerId)) {
                release(e.pointerId, e.currentTarget as HTMLElement);
              }
            }}
            onContextMenu={(e) => e.preventDefault()}
          />
        );
      })}
    </div>
  );
}
