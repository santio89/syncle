/**
 * Consolidated "Gameplay" settings control.
 *
 * Sibling to `VideoSettingsPopover` - same anchoring / portal /
 * transition vocabulary, same trigger variants, just owns the
 * gameplay-feel knobs instead of the visual ones:
 *
 *   - Metronome   (audible click track on every beat, key: M)
 *   - Feedback    (hit / miss / release / milestone SFX, key: N)
 *   - Keybinds    (4 lanes x 2 slots each, click-to-rebind editor +
 *                  reset-to-defaults; persisted via lib/game/settings)
 *
 * Variants:
 *   - `"card"` - rectangular tile used in the StartCard (solo) and
 *     the lobby `PlayerSettingsModal`. Spans `sm:col-span-2` via the
 *     `className` prop so it sits above the volume slider as a
 *     prominent gateway to the three sub-settings.
 *   - `"chip"` - compact horizontal row used in the in-match right-
 *     rail (solo `HUD` and multi `HealthPanel`). Mirrors the
 *     `VideoSettingsPopover` chip dressing exactly so the two
 *     popover triggers read as a matched pair.
 *
 * Keybinds editor:
 *   The editor renders 4 lane rows, each with two slot buttons (the
 *   primary + secondary key for that lane). Clicking a slot puts the
 *   popover into a `capturing` state - the next non-reserved keydown
 *   binds that slot. Escape cancels capture without binding. Reserved
 *   codes (Tab / F-keys / Esc / M / N / OS keys - see
 *   `RESERVED_KEYBIND_CODES` in `lib/game/settings`) are silently
 *   ignored so the slot stays in capture mode. The capture handler is
 *   registered on `document` in CAPTURE phase, which means it always
 *   fires before the in-game lane handler on `window` (bubble phase),
 *   so binding D mid-match doesn't also fire as a lane press for that
 *   exact event.
 */

"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  DEFAULT_KEYBINDS,
  formatKeyCode,
  RESERVED_KEYBIND_CODES,
  setKeybind,
  type KeyBindings,
} from "@/lib/game/settings";
import { LANE_COLORS } from "@/lib/game/types";

export interface GameplaySettingsPopoverProps {
  metronome: boolean;
  onToggleMetronome: () => void;
  sfx: boolean;
  onToggleSfx: () => void;
  /** Current per-lane keybinds (4 lanes x 2 slots). */
  keybinds: KeyBindings;
  /** Called whenever the editor commits a slot change or a reset. The
   *  caller is responsible for persisting (saveKeybinds) and updating
   *  the live key-handler ref. */
  onChangeKeybinds: (next: KeyBindings) => void;
  /** Trigger dressing - see file header. */
  variant: "card" | "chip";
  /** Extra classes appended to the trigger button (StartCard /
   *  PlayerSettingsModal use this to force `sm:col-span-2`). Optional;
   *  defaults to empty. Panel classes are never affected. */
  className?: string;
}

/**
 * Approximate rendered height of the popover panel - generous so we
 * pre-flip to "open above" early on cramped HUD layouts. The panel
 * is taller than the Video popover because the keybinds editor adds
 * 4 lane rows + a Reset button, so the over-estimate is intentional.
 */
const PANEL_ESTIMATED_H = 380;
const PANEL_WIDTH = 340;
const VIEWPORT_PAD = 8;

const LANE_ROW_LABELS = ["Lane 1", "Lane 2", "Lane 3", "Lane 4"];
const DEFAULT_KEYBINDS_FLAT = DEFAULT_KEYBINDS.flatMap((p) => [p[0], p[1]]);

/** True when any slot deviates from `DEFAULT_KEYBINDS`. Drives the
 *  trigger's accent highlight - same affordance the Video popover
 *  uses to hint "you've tweaked something here". */
function isCustomized(b: KeyBindings): boolean {
  let i = 0;
  for (const pair of b) {
    if (pair[0] !== DEFAULT_KEYBINDS_FLAT[i++]) return true;
    if (pair[1] !== DEFAULT_KEYBINDS_FLAT[i++]) return true;
  }
  return false;
}

export function GameplaySettingsPopover(props: GameplaySettingsPopoverProps) {
  const {
    metronome,
    onToggleMetronome,
    sfx,
    onToggleSfx,
    keybinds,
    onChangeKeybinds,
    variant,
    className,
  } = props;

  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState<{
    top: number;
    left: number;
    origin: "top" | "bottom";
  } | null>(null);
  const [capturing, setCapturing] = useState<{ lane: number; slot: 0 | 1 } | null>(
    null,
  );

  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);

  const headingId = useId();

  useEffect(() => {
    if (typeof document !== "undefined") setPortalHost(document.body);
  }, []);

  const close = useCallback(() => {
    setCapturing(null);
    setVisible(false);
    window.setTimeout(() => setMounted(false), 220);
  }, []);

  const openPopover = useCallback(() => {
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
    setMounted(true);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setVisible(true));
    });
  }, []);

  const toggle = useCallback(() => {
    if (mounted) close();
    else openPopover();
  }, [mounted, close, openPopover]);

  // Outside-click + Esc dismiss + capture-mode keydown listener. All
  // wired into a single effect so the capture-vs-close fork lives in
  // one place and reads the same `capturing` snapshot. Capture phase
  // is critical: the in-game lane handler is on `window` in bubble
  // phase, so the capture-phase document listener always wins for
  // mid-match rebinds, and `e.stopPropagation()` keeps the bound key
  // from also firing as a lane press the same frame.
  useEffect(() => {
    if (!mounted) return;
    function onKey(e: KeyboardEvent) {
      if (capturing) {
        if (e.code === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          setCapturing(null);
          return;
        }
        if (RESERVED_KEYBIND_CODES.has(e.code)) {
          // Reserved keys are silently ignored - the slot stays in
          // capture mode waiting for a valid bind. We also halt the
          // event so the in-match M/N hotkeys (toggle metronome /
          // feedback) don't fire as a side-effect of the player
          // experimenting with what they can or can't bind.
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        onChangeKeybinds(setKeybind(keybinds, capturing.lane, capturing.slot, e.code));
        setCapturing(null);
        return;
      }
      if (e.code === "Escape") {
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
  }, [mounted, capturing, keybinds, onChangeKeybinds, close]);

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

  // Memoised "keybinds differ from defaults" signal. Drives both the
  // trigger's accent highlight (via `highlighted` below) AND the
  // enabled state of the Reset button in the keybinds editor -
  // clicking a reset that has nothing to reset is just noise, and
  // users flagged the always-clickable button as misleading (feels
  // like something should happen when they tap it). The disabled
  // state is rendered visually (greyed-out) and reinforced with a
  // "Already on defaults" tooltip so the inert click doesn't read
  // as a bug.
  const keybindsCustomized = isCustomized(keybinds);
  const highlighted = keybindsCustomized || metronome || !sfx;

  // --- TRIGGER ---------------------------------------------------
  const trigger = variant === "card" ? (
    <button
      ref={triggerRef}
      type="button"
      onClick={toggle}
      className={`flex cursor-pointer flex-col justify-between gap-1 border-2 border-bone-50/30 bg-ink-900/50 px-3 py-2 text-left${className ? ` ${className}` : ""}`}
      data-tooltip="Metronome, feedback, keybinds"
      aria-label="Open gameplay settings"
      aria-haspopup="dialog"
      aria-expanded={mounted}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[10.5px] uppercase tracking-widest text-bone-50/70">
          Gameplay
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
        metronome · feedback · keybinds
      </span>
    </button>
  ) : (
    <button
      ref={triggerRef}
      type="button"
      onClick={toggle}
      className={`pointer-events-auto flex w-full cursor-pointer items-center justify-between gap-2 border border-bone-50/30 bg-ink-900/40 px-2.5 py-2 text-left${className ? ` ${className}` : ""}`}
      data-tooltip="Metronome, feedback, keybinds"
      aria-label="Open gameplay settings"
      aria-haspopup="dialog"
      aria-expanded={mounted}
    >
      <span className="flex flex-col">
        <span className="font-mono text-[9.2px] uppercase tracking-widest text-bone-50/70 sm:text-[10.2px]">
          Gameplay
        </span>
        <span className="font-mono text-[9.2px] tracking-widest text-bone-50/40">
          metronome · feedback · keys
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
  // Solid panel surface (NOT `.brut-card`). Same rationale as the
  // Video popover - `.brut-card`'s `background` shorthand + backdrop
  // blur fight `bg-ink-900` and produce noisy bleed-through over the
  // live canvas + HUD overlays. Inline shadow keeps the brutalist
  // offset-block depth.
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
          <div
            className="flex flex-col gap-2 border-2 border-bone-50/30 bg-ink-900 p-3"
            style={{ boxShadow: "6px 6px 0 0 rgb(var(--shadow))" }}
          >
            <div className="flex items-baseline justify-between gap-3">
              <p
                id={headingId}
                className="font-mono text-[10px] uppercase tracking-[0.4em] text-accent"
              >
                ░ Gameplay
              </p>
              <button
                type="button"
                onClick={close}
                className="font-mono text-[12px] leading-none text-bone-50/55 transition-colors hover:text-accent"
                aria-label="Close gameplay settings"
                data-tooltip="Close (ESC)"
              >
                ✕
              </button>
            </div>

            {/* Audio toggles row - Metronome + Feedback paired
                side-by-side, mirrors the StartCard's old direct-tile
                pair so a returning player still finds them in the
                same visual relationship. `<label>` wrap keeps the
                whole tile clickable (caption included). */}
            <div className="grid grid-cols-2 gap-2">
              <label
                className="flex cursor-pointer flex-col justify-between gap-1 border-2 border-bone-50/30 bg-ink-900/50 px-3 py-2"
                data-tooltip="Audible click track on every beat (key: M)"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="font-mono text-[10.5px] uppercase tracking-widest text-bone-50/70">
                    Metronome
                  </span>
                  <input
                    type="checkbox"
                    checked={metronome}
                    onChange={onToggleMetronome}
                    className="h-[1.05rem] w-[1.05rem] cursor-pointer accent-accent"
                    aria-label="Toggle metronome"
                    aria-keyshortcuts="M"
                  />
                </div>
                <span className="font-mono text-[9.5px] text-bone-50/40">
                  press M to toggle in-game
                </span>
              </label>

              <label
                className="flex cursor-pointer flex-col justify-between gap-1 border-2 border-bone-50/30 bg-ink-900/50 px-3 py-2"
                data-tooltip="Hit / miss / release sound effects on every key press (key: N)"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="font-mono text-[10.5px] uppercase tracking-widest text-bone-50/70">
                    Feedback
                  </span>
                  <input
                    type="checkbox"
                    checked={sfx}
                    onChange={onToggleSfx}
                    className="h-[1.05rem] w-[1.05rem] cursor-pointer accent-accent"
                    aria-label="Toggle input sound effects"
                    aria-keyshortcuts="N"
                  />
                </div>
                <span className="font-mono text-[9.5px] text-bone-50/40">
                  press N to toggle in-game
                </span>
              </label>
            </div>

            {/* Keybinds editor. Each lane row carries a colored swatch
                (using LANE_COLORS so red/yellow/green/blue read the
                same as the canvas), the lane label, and two slot
                buttons. Clicking a slot puts that slot into capture
                mode - the next non-reserved keydown binds it. Esc
                cancels capture. Same code is automatically pulled out
                of any other slot it occupied (see `setKeybind` in
                `lib/game/settings`) so we never end up with two lanes
                claiming the same physical key. */}
            <div className="mt-1 flex flex-col gap-1.5 border-2 border-bone-50/30 bg-ink-900/40 px-3 py-2.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-mono text-[10.5px] uppercase tracking-widest text-bone-50/70">
                  Keybinds
                </span>
                <span className="font-mono text-[9.5px] text-bone-50/40">
                  click a slot · press a key
                </span>
              </div>
              {[0, 1, 2, 3].map((lane) => {
                const pair = keybinds[lane];
                return (
                  <div
                    key={lane}
                    className="flex items-center gap-2"
                  >
                    <span
                      aria-hidden
                      className="inline-block h-[10px] w-[10px] flex-none border border-bone-50/40"
                      style={{ background: LANE_COLORS[lane] }}
                    />
                    <span className="w-[44px] flex-none font-mono text-[9.5px] uppercase tracking-widest text-bone-50/55">
                      {LANE_ROW_LABELS[lane]}
                    </span>
                    {[0, 1].map((s) => {
                      const slot = s as 0 | 1;
                      const code = pair[slot];
                      const isCapturing = capturing?.lane === lane && capturing.slot === slot;
                      const label = isCapturing
                        ? "press key..."
                        : code
                          ? formatKeyCode(code)
                          : "-";
                      return (
                        <button
                          key={slot}
                          type="button"
                          onClick={() => {
                            setCapturing(isCapturing ? null : { lane, slot });
                          }}
                          // Right-click clears the slot. Quicker than
                          // entering capture and pressing some
                          // throwaway key the player would then have
                          // to clean up. Standard rebind UX in most
                          // games (Source / Unity defaults / etc).
                          onContextMenu={(e) => {
                            e.preventDefault();
                            if (isCapturing) setCapturing(null);
                            onChangeKeybinds(setKeybind(keybinds, lane, slot, ""));
                          }}
                          className={`flex-1 cursor-pointer border px-2 py-1.5 font-mono text-[10.5px] uppercase tracking-widest transition-colors ${
                            isCapturing
                              ? "border-accent bg-accent/10 text-accent"
                              : code
                                ? "border-bone-50/30 bg-ink-900/60 text-bone-50/80 hover:border-accent hover:text-accent"
                                : "border-bone-50/20 bg-ink-900/40 text-bone-50/40 hover:border-accent hover:text-accent"
                          }`}
                          data-tooltip={
                            isCapturing
                              ? "Press any key to bind · Esc to cancel · right-click to clear"
                              : code
                                ? `Bound: ${formatKeyCode(code)} · click to rebind · right-click to clear`
                                : "Unbound · click to bind · right-click to clear"
                          }
                          aria-label={`Lane ${lane + 1} ${slot === 0 ? "primary" : "secondary"} keybind`}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                );
              })}
              <button
                type="button"
                onClick={() => {
                  setCapturing(null);
                  onChangeKeybinds(DEFAULT_KEYBINDS);
                }}
                disabled={!keybindsCustomized}
                className={`mt-1 self-end border px-2 py-1 font-mono text-[9.5px] uppercase tracking-widest transition-colors ${
                  keybindsCustomized
                    ? "cursor-pointer border-bone-50/30 bg-ink-900/60 text-bone-50/70 hover:border-accent hover:text-accent"
                    : "cursor-not-allowed border-bone-50/15 bg-ink-900/40 text-bone-50/30"
                }`}
                data-tooltip={
                  keybindsCustomized
                    ? "Reset all keybinds to D F J K + arrow keys"
                    : "Already on defaults"
                }
                aria-label="Reset keybinds to defaults"
              >
                Reset to defaults
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
