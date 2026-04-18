/**
 * Tiny "just copied" pill that overlays above its sibling trigger.
 *
 * Designed to be dropped inside a `position: relative` wrapper next
 * to a copy button — the pill is `absolute`-positioned so it never
 * shifts the surrounding layout, and uses opacity transitions
 * instead of mount/unmount so the fade-out actually plays. Pair
 * with `useCopyToClipboard()` and feed its `copied` flag into
 * `visible`.
 *
 * Brutalist look matches the rest of the UI (mono caps, accent
 * border, square corners). `aria-live="polite"` so screen readers
 * announce the copy without preempting other speech.
 */
export function CopyToast({
  visible,
  message = "Copied to clipboard",
}: {
  visible: boolean;
  /**
   * Override label. Defaults to "Copied to clipboard" — the most
   * common case. Pass shorter text (e.g. "Copied!") when space is
   * tight or the trigger is small.
   */
  message?: string;
}) {
  return (
    <span
      role="status"
      aria-live="polite"
      className={`pointer-events-none absolute left-1/2 top-0 z-10 -translate-x-1/2 -translate-y-[calc(100%+6px)] whitespace-nowrap border-2 border-accent bg-ink-900 px-2 py-0.5 font-mono text-[9.5px] uppercase tracking-widest text-accent shadow-lg transition-opacity duration-150 ${
        visible ? "opacity-100" : "opacity-0"
      }`}
    >
      {message}
    </span>
  );
}
