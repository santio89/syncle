"use client";

/**
 * Leave-guard infrastructure used to prevent accidental drop-outs from
 * an active multiplayer room or a single-player run.
 *
 * Three escape hatches exist for the average user; we cover all of them:
 *
 *   1. Tab / window close, refresh, address-bar URL change → `beforeunload`
 *      shows the browser-native "leave this site?" dialog. We can't style
 *      it (security restriction since 2017) but it does fire reliably.
 *
 *   2. Browser back / forward buttons → SPA navigations that DON'T fire
 *      `beforeunload`. Intercepted via a `popstate` sentinel pattern:
 *      on guard mount we push a duplicate of the current URL with a
 *      tagged state object onto the history stack. The browser back
 *      button then pops the sentinel, leaving the URL unchanged but
 *      firing `popstate`; we re-push the sentinel (so the URL stays put)
 *      and surface our own confirm modal. If the user accepts the leave,
 *      we run their registered `defaultLeave` action — same one the
 *      in-app "Back" button would have called.
 *
 *   3. In-page navigation (header Back arrow, HomeButton, anchor links)
 *      → components call `attemptLeave(proceed)` instead of navigating
 *      directly. When the guard is off, it calls `proceed()` immediately
 *      (zero overhead). When on, it opens the same confirm modal and
 *      runs `proceed()` only on user accept.
 *
 * The provider is mounted globally in `app/layout.tsx`; it's inert
 * when no guards are registered, so the cost on idle pages is one
 * context value + a couple of refs.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

interface RegisteredGuard {
  id: string;
  enabled: boolean;
  message: string;
  /**
   * Called when the user confirms a leave triggered by browser back
   * button (popstate). Should fully tear down the page-local
   * resources (socket leave, audio stop, etc.) AND push the user
   * to wherever the in-page "Back" button would have sent them.
   *
   * `null` is allowed for guards that only want the beforeunload
   * dialog and the in-page button intercepts (no popstate handling
   * needed). In practice we always set this for safety.
   */
  defaultLeave: (() => void) | null;
}

interface LeaveGuardContextValue {
  /**
   * Register / update a guard. Returns an unregister function the
   * hook calls during cleanup. Multiple guards can coexist (the
   * provider treats the leave-prompt as active if ANY guard reports
   * `enabled === true`).
   */
  registerGuard: (guard: RegisteredGuard) => () => void;
  /**
   * Wrap any in-app leave action. If no guard is active, runs
   * `proceed()` synchronously. Otherwise opens the confirm modal
   * and runs `proceed()` only after user accept.
   */
  attemptLeave: (proceed: () => void) => void;
  /**
   * Whether ANY guard is currently active. Used by ambient nav
   * components like `HomeButton` to decide between `router.push`
   * (preserve history) and `router.replace` (collapse the guarded
   * URL out of history) so the back button doesn't loop into a
   * stale "no session" mount of the guarded page.
   */
  hasActiveGuard: boolean;
}

const LeaveGuardCtx = createContext<LeaveGuardContextValue | null>(null);

const SENTINEL_KEY = "__syncleLeaveGuard__";

interface PendingPrompt {
  message: string;
  proceed: () => void;
}

export function LeaveGuardProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const guardsRef = useRef<Map<string, RegisteredGuard>>(new Map());
  // The window-level effect (beforeunload + popstate sentinel) only
  // depends on whether ANY guard is enabled — NOT on the message
  // string or the defaultLeave callback. If we re-ran that effect
  // on every message change (e.g. multi-room snapshot phase flips
  // between "lobby" and "match in progress"), we'd push a fresh
  // popstate sentinel into history each time and stack up duplicate
  // entries that the user has to walk past with multiple back
  // presses. Keeping it boolean-only means one sentinel per "guard
  // session", which is what the user-visible behavior expects.
  const [hasActiveGuard, setHasActiveGuard] = useState(false);
  const [pending, setPending] = useState<PendingPrompt | null>(null);
  /**
   * When the user accepts a leave, the proceed callback typically
   * runs `router.replace()` (or, less commonly, `router.push()`).
   * Either of those can fire `popstate` (pop side definitely; push
   * side won't, but the synchronous `history.back()` we run BEFORE
   * proceed to clean up the sentinel definitely will). The popstate
   * handler below treats sentinel pops as "user pressed browser
   * back" and would helpfully re-prompt — opening a SECOND modal
   * that traps them in a loop.
   *
   * This ref is the cross-handler escape hatch: anyone about to
   * trigger a confirmed-leave navigation flips it true so the very
   * next popstate is ignored. We reset it on a short delay so real
   * back presses a few seconds later still get caught.
   */
  const bypassNextPopstateRef = useRef(false);
  /**
   * True iff the popstate sentinel is currently sitting on top of
   * history. We pop it on confirmed leave so the destination URL
   * replaces the ORIGINAL guarded URL (via the proceed callback's
   * `router.replace`) instead of stacking on top of it. Without
   * this, browser back after leaving lands the user back on the
   * guarded URL — which re-mounts the page in its "no session"
   * fallback (e.g. the JoinForm on `/multi/[code]`) and creates a
   * loop with the destination URL on either side.
   */
  const sentinelActiveRef = useRef(false);

  /**
   * Snapshot the latest active guard at prompt-fire time. Stored as
   * a ref so the popstate / attemptLeave handlers always read the
   * most recent state without re-binding the window listeners. We
   * pick the LAST enabled guard in insertion order (most recently
   * mounted page wins), which matches the user's mental model of
   * "the page I'm on right now decides the message".
   */
  const getActiveGuard = useCallback((): RegisteredGuard | null => {
    let next: RegisteredGuard | null = null;
    for (const g of guardsRef.current.values()) {
      if (g.enabled) next = g;
    }
    return next;
  }, []);

  const recomputeActive = useCallback(() => {
    const next = getActiveGuard() !== null;
    setHasActiveGuard((prev) => (prev === next ? prev : next));
  }, [getActiveGuard]);

  const registerGuard = useCallback<LeaveGuardContextValue["registerGuard"]>(
    (guard) => {
      guardsRef.current.set(guard.id, guard);
      recomputeActive();
      return () => {
        guardsRef.current.delete(guard.id);
        recomputeActive();
      };
    },
    [recomputeActive],
  );

  /**
   * Shared "user said yes, leave" finalizer. Runs the page-local
   * cleanup (proceed callback) and pops the sentinel so the
   * destination URL takes the sentinel's slot instead of stacking
   * — see `sentinelActiveRef` for the loop this prevents.
   *
   * Sequence is delicate but small:
   *   1. Arm the popstate bypass (covers any popstate fired by step 2
   *      OR by Next.js's router.replace doing internal navigation).
   *   2. Synchronously pop the sentinel via `history.back()`. URL
   *      flips back to the original guarded URL — but the page is
   *      still mounted; we never paint that intermediate state
   *      because step 3 fires before the next paint.
   *   3. Run the user's proceed callback. By convention every
   *      proceed in the codebase ends with `router.replace(dest)`,
   *      which calls `history.replaceState` to overwrite the
   *      ORIGINAL guarded URL entry with the destination. Net
   *      result: history loses both the sentinel AND the guarded
   *      URL, leaving a clean tree-style "back goes to where I
   *      came from".
   */
  const performGuardedLeave = useCallback((proceed: () => void) => {
    bypassNextPopstateRef.current = true;
    // Reset on a short delay so any real back press the user makes
    // a few seconds later still gets caught. 100ms is enough to
    // cover the synchronous history.back + router.replace sequence
    // plus any Next.js internal popstate that might trail.
    setTimeout(() => {
      bypassNextPopstateRef.current = false;
    }, 100);

    if (sentinelActiveRef.current && typeof window !== "undefined") {
      try {
        window.history.back();
      } catch {
        /* ignore — proceed will navigate either way */
      }
      sentinelActiveRef.current = false;
    }
    proceed();
  }, []);

  const attemptLeave = useCallback<LeaveGuardContextValue["attemptLeave"]>(
    (proceed) => {
      const g = getActiveGuard();
      if (!g) {
        // No guard active — pass-through. No sentinel to pop, no
        // history rewrite needed; the caller's router.push /
        // router.replace runs as-is.
        proceed();
        return;
      }
      setPending({
        message: g.message,
        proceed: () => performGuardedLeave(proceed),
      });
    },
    [getActiveGuard, performGuardedLeave],
  );

  // ---- beforeunload + popstate window-level guards --------------------
  //
  // Installed once whenever a guard becomes active and torn down
  // when the LAST guard unregisters. We deliberately key this off
  // the boolean `hasActiveGuard` (NOT the guard object identity) so
  // that swapping the message string / defaultLeave callback
  // mid-session — e.g. multi-room snapshot phase flipping the
  // copy from "lose your seat" to "drop out of the round" — does
  // NOT re-run this effect and stack a fresh popstate sentinel into
  // history.
  useEffect(() => {
    if (!hasActiveGuard) return;

    // (1) beforeunload — tab close, refresh, address-bar URL change.
    // Spec quirk: we MUST both `preventDefault()` and assign a
    // string to `returnValue` to get the dialog in all browsers.
    // The custom string is ignored by every modern browser (a
    // generic "leave site?" message is shown instead) but the
    // assignment is the trigger.
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
      return "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);

    // (2) popstate — SPA back / forward buttons. We push a sentinel
    // history entry that pins the user to the current URL; when the
    // browser back button pops it, popstate fires WITHOUT changing
    // the URL, and we surface the confirm modal. Re-pushing on each
    // pop keeps the user trapped here until they accept the leave.
    const guardedPathname =
      typeof window !== "undefined" ? window.location.pathname : null;
    const guardedSearch =
      typeof window !== "undefined" ? window.location.search : "";
    const sentinelState = { [SENTINEL_KEY]: true };

    if (typeof window !== "undefined") {
      try {
        window.history.pushState(
          sentinelState,
          "",
          window.location.href,
        );
        sentinelActiveRef.current = true;
      } catch {
        // Some embedded contexts (Cypress test frame, certain
        // about: pages) refuse pushState. The beforeunload guard
        // alone still covers the most important escape route.
      }
    }

    const onPopState = () => {
      if (bypassNextPopstateRef.current) {
        bypassNextPopstateRef.current = false;
        return;
      }
      // If the user navigated to a DIFFERENT pathname despite the
      // sentinel (could happen on rapid double-back, or extension
      // interference), don't trap them — they're already off the
      // guarded page. Cleanup will tear the handler down on the
      // next render cycle.
      if (window.location.pathname !== guardedPathname) {
        return;
      }
      // Keep the user pinned: re-push the sentinel so a follow-up
      // back press doesn't slip past us while the modal is open.
      try {
        window.history.pushState(
          sentinelState,
          "",
          guardedPathname + guardedSearch,
        );
        sentinelActiveRef.current = true;
      } catch {
        /* ignore */
      }
      // Read the current active guard at fire-time (NOT mount-time)
      // so message + defaultLeave reflect the latest snapshot — e.g.
      // a multi-room phase change between sentinel push and back
      // press should still yield the right copy + leave action.
      const current = getActiveGuard();
      if (!current) return;
      setPending({
        message: current.message,
        proceed: () =>
          performGuardedLeave(() => {
            // defaultLeave is the page's "what would the in-page
            // Back button have done?" — same contract, same
            // expected use of router.replace inside.
            if (current.defaultLeave) {
              current.defaultLeave();
            } else {
              // Fallback for guards that didn't register a
              // defaultLeave: history.back gets the user off the
              // guarded page (sentinel was already popped by
              // performGuardedLeave; this pops the original entry).
              try {
                window.history.back();
              } catch {
                /* ignore */
              }
            }
          }),
      });
    };
    window.addEventListener("popstate", onPopState);

    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("popstate", onPopState);
      // The accept path (`performGuardedLeave`) is responsible for
      // popping the sentinel + having proceed router.replace away
      // from the guarded URL, so by the time this cleanup runs the
      // sentinel is usually already gone. The flag is reset here
      // for any stray case (e.g. guard programmatically deactivated
      // by the page itself instead of via a confirmed leave) so
      // the next mount starts from a known state.
      sentinelActiveRef.current = false;
    };
  }, [hasActiveGuard, getActiveGuard, performGuardedLeave]);

  return (
    <LeaveGuardCtx.Provider
      value={{ registerGuard, attemptLeave, hasActiveGuard }}
    >
      {children}
      {pending && (
        <LeaveConfirmModal
          message={pending.message}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const fn = pending.proceed;
            // Clear the prompt FIRST so the modal disappears even
            // if `proceed()` synchronously re-renders (e.g.
            // router.push triggering a fresh route).
            setPending(null);
            try {
              fn();
            } catch (err) {
              // Surface in dev but never crash the modal — we'd
              // strand the user on the dim backdrop.
              if (
                typeof window !== "undefined" &&
                window.console
              ) {
                console.error("[LeaveGuard] proceed handler threw:", err);
              }
            }
          }}
        />
      )}
    </LeaveGuardCtx.Provider>
  );
}

/**
 * Register a leave guard for the current page.
 *
 * `enabled` should reflect whether the user is currently doing
 * something they'd be sad to lose (in a multiplayer room / mid-song,
 * etc.). When false, all infrastructure is detached and any leave
 * attempt is a synchronous pass-through.
 *
 * `message` is shown in the confirm modal. The browser-native
 * `beforeunload` dialog will use a generic message regardless of
 * what we pass — that's a security restriction.
 *
 * `defaultLeave` is invoked when the user confirms a leave triggered
 * by the browser back button. Should run the same cleanup the
 * in-page "Back" button runs, then push the user somewhere sensible.
 */
export function useLeaveGuard({
  enabled,
  message,
  defaultLeave,
}: {
  enabled: boolean;
  message: string;
  defaultLeave?: () => void;
}) {
  const ctx = useContext(LeaveGuardCtx);
  const id = useId();
  // Stash the latest defaultLeave in a ref so callers can pass an
  // inline arrow without retriggering registration on every render.
  // Same pattern as the message — only the boolean `enabled` and the
  // ref-stable identifiers are dep-checked below.
  const leaveRef = useRef<typeof defaultLeave>(defaultLeave);
  useEffect(() => {
    leaveRef.current = defaultLeave;
  }, [defaultLeave]);

  useEffect(() => {
    if (!ctx) return;
    return ctx.registerGuard({
      id,
      enabled,
      message,
      defaultLeave: () => leaveRef.current?.(),
    });
  }, [ctx, id, enabled, message]);
}

/**
 * Get the `attemptLeave(proceed)` helper for wrapping in-page
 * navigation buttons (header Back arrow, HomeButton, anchor links).
 * When no guard is active, behaves as a no-op pass-through.
 */
export function useAttemptLeave(): (proceed: () => void) => void {
  const ctx = useContext(LeaveGuardCtx);
  return ctx?.attemptLeave ?? ((proceed) => proceed());
}

/**
 * Read whether ANY leave guard is currently active. Components like
 * `HomeButton` use this to choose `router.replace` (when guarded —
 * collapse the guarded URL out of history) vs `router.push` (when
 * unguarded — preserve the regular link semantic so back returns to
 * the prior page).
 */
export function useHasActiveLeaveGuard(): boolean {
  const ctx = useContext(LeaveGuardCtx);
  return ctx?.hasActiveGuard ?? false;
}

// ---------------------------------------------------------------------------

/**
 * Brutalist-styled leave confirmation modal. Mirrors the
 * `MatchMenuOverlay` / `PauseCard` chrome (heavy borders, mono
 * micro-copy, accent button + ghost button) so it feels like a
 * native part of the same UI surface rather than a generic system
 * dialog.
 *
 * Keyboard shortcuts:
 *   - Esc → cancel (stay)
 *   - Enter → confirm (leave)
 *
 * Note: we DON'T trap focus or render to a portal. The modal sits
 * at z-50 with a full-bleed backdrop + pointer-events-auto, which
 * is enough to swallow stray clicks while the prompt is up. A more
 * formal a11y treatment can be retrofitted if real screen-reader
 * users start using the app.
 */
function LeaveConfirmModal({
  message,
  onConfirm,
  onCancel,
}: {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    // Capture phase + stopImmediatePropagation so this listener owns
    // ESC/ENTER while the modal is up. Without this, page-level
    // keydown handlers ALSO fire on the same event:
    //   - `ResultsScreen` listens for ESC and calls handleLeave →
    //     attemptLeave → reopens the modal we just closed (infinite
    //     re-prompt loop).
    //   - `MultiGame` toggles the match menu on ESC.
    //   - `Game.tsx` pauses / goes home on ESC.
    // Capture-phase guarantees we run before the page handlers (which
    // are registered in the bubble phase), and stopImmediatePropagation
    // also blocks any other capture-phase modal that might land later.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onCancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onConfirm();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, [onCancel, onConfirm]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/75 px-4 backdrop-blur"
      role="dialog"
      aria-modal="true"
      aria-label="Confirm leaving"
      onClick={(e) => {
        // Click outside the card = cancel. Inner card stops
        // propagation below so a click ON the card doesn't
        // collapse the prompt.
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="brut-card w-full max-w-md p-7 sm:p-9 text-center"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="font-mono text-[10.5px] uppercase tracking-[0.4em] text-accent">
          ░ Leave?
        </p>
        <h2 className="mt-3 font-display text-[1.85rem] font-bold leading-tight">
          Are you sure?
        </h2>
        <p className="mt-3 font-mono text-[0.79rem] uppercase tracking-widest text-bone-50/60">
          {message}
        </p>
        <div className="mt-7 grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="brut-btn-accent px-4 py-3"
            autoFocus
          >
            ▶ Stay
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="brut-btn px-4 py-3"
          >
            ✕ Leave
          </button>
        </div>
        <p className="mt-4 font-mono text-[10.5px] uppercase tracking-widest text-bone-50/40">
          ESC = stay · ENTER = leave
        </p>
      </div>
    </div>
  );
}
