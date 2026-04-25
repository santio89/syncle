"use client";

/**
 * PrestartOverlay
 * ----------------
 * Centered, full-bleed modal that appears for every player in a room
 * during the brief 3 s "starting in 3, 2, 1…" window after the host
 * clicks Start. The countdown is server-driven - every client computes
 * remaining seconds against `RoomSnapshot.prestartEndsAt` so all
 * overlays show the same number at the same wall-clock moment.
 *
 * Affordances:
 *   - Body: large countdown integer + "Match starting" label.
 *   - Footer (host only): "Cancel" button that fires `host:cancelStart`,
 *     which the server turns into a "Match cancelled" notice + a
 *     snapshot with `prestartEndsAt = null`. As soon as that snapshot
 *     lands every overlay collapses back to the lobby.
 *   - Footer (non-host): subtle "host can cancel" hint.
 *
 * Lifecycle:
 *   - Parent (`RoomBody`) mounts/unmounts based on
 *     `snapshot.prestartEndsAt !== null`. We don't manage our own
 *     show/hide state - the snapshot IS the state.
 *   - Internal `seconds` state ticks via rAF every ~100 ms so the
 *     number doesn't jitter against the system clock and we don't pay
 *     the cost of a 16 ms timer for a 3 s overlay. Falls back to the
 *     last computed value once the deadline passes (display freezes at
 *     0 until the snapshot lands and the overlay unmounts).
 *
 * Visuals:
 *   - Same brut-card / accent palette as `LeaveConfirmModal` so the
 *     two share a consistent "this is a confirm-style modal" feel.
 *   - Pulses gently to draw the eye without being obnoxious.
 *   - z-50 sits above the lobby but below the leave-guard modal
 *     (which is also z-50; the leave-guard mounts later in the tree
 *     so it wins the z-order tie if both happen to be open).
 */

import { useEffect, useState } from "react";

interface Props {
  /** Wall-clock ms when the prestart finishes and the loading phase begins. */
  endsAt: number;
  /** Whether the local player is the host (gates the Cancel button). */
  isHost: boolean;
  /** Fires `host:cancelStart`. Only invoked when isHost is true. */
  onCancel: () => void;
}

export default function PrestartOverlay({ endsAt, isHost, onCancel }: Props) {
  const [seconds, setSeconds] = useState(() => computeSeconds(endsAt));

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      setSeconds(computeSeconds(endsAt));
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [endsAt]);

  useEffect(() => {
    // Host-only ESC shortcut to cancel. Non-hosts have no cancel
    // affordance, so ESC is a no-op for them (and intentionally does
    // NOT close the overlay - there's nothing for the player to do
    // here except wait the 3 s out).
    //
    // Capture phase + stopImmediatePropagation so we own ESC while
    // the overlay is up and any page-level handler (MultiGame menu,
    // Game.tsx pause) doesn't ALSO fire on the same event.
    if (!isHost) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [isHost, onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/75 px-4 backdrop-blur"
      role="dialog"
      aria-modal="true"
      aria-label="Match starting"
    >
      <div className="brut-card w-full max-w-md p-7 sm:p-9 text-center">
        <p className="font-mono text-[10.5px] uppercase tracking-[0.4em] text-accent">
          ░ Match starting
        </p>
        <p
          // `tabular-nums` keeps the digit width steady so the card
          // doesn't reflow as 3 → 2 → 1. `animate-pulse-soft` is too
          // heavy for a 3 s overlay; a CSS transition on a key change
          // would feel snappier but adds complexity for little gain -
          // the static large number does the job.
          className="mt-4 font-display text-[5.5rem] font-bold leading-none tabular-nums text-accent"
          aria-live="polite"
        >
          {seconds}
        </p>
        <p className="mt-3 font-mono text-[0.79rem] uppercase tracking-widest text-bone-50/70">
          Starting in {seconds}…
        </p>
        {isHost ? (
          <>
            <button
              type="button"
              onClick={onCancel}
              className="brut-btn mt-7 w-full px-4 py-3"
              autoFocus
            >
              ✕ Cancel
            </button>
            <p className="mt-4 font-mono text-[10.5px] uppercase tracking-widest text-bone-50/40">
              ESC to cancel · only the host can stop the start
            </p>
          </>
        ) : (
          <p className="mt-7 font-mono text-[10.5px] uppercase tracking-widest text-bone-50/40">
            Waiting for the host · they can still cancel
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Whole seconds remaining until `endsAt`. Floors so the integer
 * counter feels "right" - at t = 2.4 s remaining the user expects to
 * see "3" (the third second is still running), not "2". Clamped at 0
 * to avoid showing negatives during the brief gap between the timer
 * elapsing on the server and the next snapshot landing here.
 */
function computeSeconds(endsAt: number): number {
  const remaining = endsAt - Date.now();
  if (remaining <= 0) return 0;
  return Math.max(0, Math.ceil(remaining / 1000));
}
