import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Copy a string to the system clipboard and surface a transient
 * "just copied" flag the caller can wire to UI feedback (toast pill,
 * icon swap, etc.).
 *
 * The flag auto-resets to `false` after `timeoutMs` so callers don't
 * need their own setTimeout, and the timer is cleared on unmount /
 * on re-copy so a stale state update never hits a torn-down
 * component or fires after the user has clicked again.
 *
 * Tolerates clipboard API absence (insecure context, ancient
 * browsers, server-rendered) by silently no-op'ing - clipboard is a
 * nice-to-have on a "click to copy" affordance, not a critical
 * path. Failed writes also no-op to keep the UI honest (no false
 * "copied" toast when nothing actually copied).
 */
export function useCopyToClipboard(timeoutMs = 1500) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const copy = useCallback(
    (text: string) => {
      if (typeof navigator === "undefined" || !navigator.clipboard) return;
      void navigator.clipboard
        .writeText(text)
        .then(() => {
          setCopied(true);
          if (timerRef.current) clearTimeout(timerRef.current);
          timerRef.current = setTimeout(() => setCopied(false), timeoutMs);
        })
        .catch(() => {
          // Permission denied or write blocked - leave `copied` false
          // so the caller doesn't show a misleading success toast.
        });
    },
    [timeoutMs],
  );

  return { copy, copied };
}
