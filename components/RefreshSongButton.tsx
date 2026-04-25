"use client";

/**
 * Compact "roll a new random track" button.
 *
 * Shared between the home page's `NOW PLAYING` card and the in-game
 * StartCard so both surfaces expose the same affordance with the same
 * recipe — the player learns the icon + label once and recognizes it
 * everywhere a random song can be swapped without a full page reload.
 *
 * Spins the icon while the new song is fetching so the player has an
 * honest indicator that something's happening — clicking again
 * mid-fetch is harmless on both call sites (each parent cancels its
 * older in-flight signal so only the freshest response wins).
 *
 * Visually borrows the brutalist chip recipe (`border-2`, square
 * corners, monospace caps inside) so it reads as a sibling of the
 * surrounding metadata chips rather than competing with the primary
 * Play / Start CTA.
 */
export function RefreshSongButton({
  onClick,
  loading,
  className,
}: {
  onClick: () => void;
  loading: boolean;
  /** Optional extra classes — lets call sites tweak spacing without
   *  losing the recipe (e.g. inline-flex sizing in tight headers). */
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      // Padding is explicit (`px-2 py-1`) rather than the
      // duration-chip recipe (`px-2 py-0.5`) for two reasons:
      //   1. This is a button that mixes a glyph (↻) with text;
      //      the glyph rides at a larger font size than the
      //      label, so symmetric box-padding plus `leading-none`
      //      is what makes the content actually center optically
      //      (not just geometrically).
      //   2. Stops it from matching the bordered-pill
      //      padding-block override in globals.css that's tuned
      //      for text-only chips and would otherwise stretch the
      //      bottom edge below the icon.
      className={`group inline-flex items-center gap-1.5 border-2 border-accent bg-transparent px-2 py-1 font-mono text-[10.5px] font-bold leading-none uppercase tracking-widest text-accent transition-colors hover:bg-accent/10 disabled:cursor-wait disabled:opacity-60${
        className ? ` ${className}` : ""
      }`}
      data-tooltip="Roll a new random track"
      aria-label="Roll a new random track"
      aria-busy={loading}
    >
      {/* Unicode ↻ glyph instead of an SVG so this button matches
          the browser-lobby's "↻ refresh" affordance one-for-one
          — three surfaces, same icon, no inconsistency. The glyph
          still spins / counter-rotates via transform classes, so
          the loading / hover affordances are unchanged. */}
      <span
        aria-hidden
        className={`inline-block text-[1.05rem] leading-none ${
          loading
            ? "animate-spin"
            : "transition-transform duration-300 group-hover:-rotate-180"
        }`}
      >
        ↻
      </span>
      <span>new</span>
    </button>
  );
}
