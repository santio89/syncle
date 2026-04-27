"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useAttemptLeave,
  useHasActiveLeaveGuard,
} from "@/components/LeaveGuardProvider";

/**
 * Header "Main menu" entry button - labeled pill that pairs the
 * `MenuIcon` play-triangle glyph (the play mark lifted straight
 * from the Syncle brand `app/icon.svg`, sans its outer square
 * frame) with an explicit "MAIN MENU" word.
 *
 * History: this used to be an icon-only 38×38 square (the outline
 * of a little house) next to `ThemeToggle` so the right side of every
 * header read as a tidy strip of icon chips. Two pieces of feedback
 * killed that approach - the same ones that killed the icon-only
 * version of `MultiButton`:
 *
 *   1. The house glyph competed with `MultiButton`'s four-dot grid
 *      and `ThemeToggle`'s sun/moon for the same "anonymous icon
 *      strip" real estate. Players on their first visit read the
 *      row as a generic toolbar, scanned past it, and hunted for
 *      the menu via the logo wordmark instead.
 *   2. The hover tooltip ("Main menu") only fired on pointer
 *      devices, so mobile users never saw the disambiguation at
 *      all - it was effectively a mystery chip.
 *
 * Fix: pair the Syncle play mark with the literal label
 * "MAIN MENU" so there's zero ambiguity on first sight on any
 * device. Using the brand's play glyph (rather than generic menu
 * hardware like a D-pad / hamburger) means the pill is in direct
 * visual conversation with the Syncle logo the user is
 * navigating to - "tap the logo, go to the logo's screen" is
 * about as unambiguous as navigation gets. Height matches
 * `.icon-btn` (38 px) so the header strip stays in vertical
 * rhythm with `ThemeToggle`; horizontal width grows to fit the
 * label. Tooltip is dropped because the visible text is now
 * self-describing - keeping a tooltip that just echoes the label
 * would be noise (same call `MultiButton` made after its own
 * relabel).
 *
 * The bordered-pill aesthetic + hover/active behavior mirrors
 * `.icon-btn` exactly (border + color → accent, 1 px sink on
 * press) so the two labeled buttons (MAIN MENU + MULTIPLAYER)
 * still read as one family with `ThemeToggle` even with different
 * proportions. Inline Tailwind (rather than `.icon-btn` + extra
 * class) because that CSS rule hard-codes `width: 38px`, which
 * we're intentionally overriding here.
 *
 * Always navigates to `/`. For "go back to where I came from"
 * there's a separate back-arrow link in the header (keeps "back"
 * and "main menu" semantically distinct).
 *
 * The click is routed through the global `LeaveGuardProvider` so
 * that an active multiplayer room or solo run can intercept it
 * and surface a "Are you sure?" prompt before the navigation
 * actually runs. When no guard is active (idle pages, homepage),
 * the intercept is a synchronous pass-through and the click flows
 * straight through to the router - same UX as a plain Link.
 */
export function HomeButton({
  className = "",
  onNavigate,
}: {
  className?: string;
  /**
   * Optional cleanup hook fired before navigation, AFTER the user
   * confirms a guarded leave. The multiplayer room uses this to
   * leave the socket cleanly so the player doesn't linger in the
   * roster for other clients during the connection grace window.
   * Skipped when the user cancels the leave prompt.
   */
  onNavigate?: () => void;
}) {
  const router = useRouter();
  const attemptLeave = useAttemptLeave();
  const guarded = useHasActiveLeaveGuard();
  return (
    <Link
      href="/"
      // We intercept the click manually so that the guard prompt
      // can run BEFORE Next.js triggers the soft navigation.
      // Plain Link `onClick` runs synchronously alongside the
      // navigation, which would let the user confirm too late.
      //
      // `router.replace` when a guard is active so the
      // LeaveGuardProvider can collapse the guarded URL (e.g.
      // /multi/[code] / /play) out of history alongside its
      // popstate sentinel - pressing browser back from / would
      // otherwise re-mount the guarded page in its "no session"
      // fallback (JoinForm / fresh random song) and trap the user
      // in a loop. On unguarded pages we keep the regular
      // `router.push` so back behaves like a normal link.
      onClick={(e) => {
        e.preventDefault();
        attemptLeave(() => {
          onNavigate?.();
          if (guarded) {
            router.replace("/");
          } else {
            router.push("/");
          }
        });
      }}
      // 38 px height matches .icon-btn / ThemeToggle / MultiButton
      // so the header strip stays aligned. Horizontal padding
      // (px-3) + gap-2 give the label and icon comfortable
      // breathing room without making the pill larger than
      // necessary at narrow viewports. Active translate matches
      // .icon-btn's 1 px tactile sink. `leading-none` collapses
      // the implicit half-leading on the text span so its
      // bounding box equals its font-size - without it, the
      // default line-height (~1.5) gives the text a taller-than-
      // needed box and the visible caps drift below the icon's
      // geometric centre even with `items-center`. Same trick
      // `MultiButton` + the `MultiEntryClient` "Refresh list"
      // button use for the same reason.
      //
      // `transform-gpu` mirrors `MultiButton` - promotes the pill
      // onto its own compositor layer so the whole row stays on
      // the same paint strategy. Not load-bearing for `MenuIcon`
      // specifically (the single polygon has no internal gutters
      // to desync), but kept for symmetry so any future glyph swap
      // inherits the same stability. The actual paint-flicker fix
      // for the 4-dot `MultiIcon` lives in that component itself
      // (dropped `shapeRendering="crispEdges"` to let the browser
      // AA at the real sub-pixel positions deterministically).
      className={`inline-flex h-[38px] items-center gap-2 border-2 border-bone-50/60 px-3 leading-none text-bone-50 transition-colors transform-gpu hover:border-accent hover:text-accent active:translate-y-[1px] ${className}`}
      // aria-label kept explicit for screen readers. The visible
      // text is already "MAIN MENU" but an explicit aria-label
      // is cheap insurance against any AT that might read the
      // icon glyph first and skip the text.
      aria-label="Main menu"
    >
      <MenuIcon size={14} />
      {/* Tracking matches the wordmark + nav text in the same
          header (font-mono, uppercase, ~0.25em tracking) so the
          label reads as part of the same typographic system.
          Slightly smaller font (10.5 px) than the body nav text
          because the surrounding border gives it visual weight
          that compensates for the smaller cap-height. Identical
          treatment to `MultiButton`'s "MULTIPLAYER" label so the
          two pills read as a matched pair. */}
      <span className="font-mono text-[10.5px] uppercase tracking-[0.25em]">
        Main menu
      </span>
    </Link>
  );
}

/**
 * Menu glyph: the play triangle lifted straight from the Syncle
 * brand mark in `app/icon.svg`, rendered on its own (no outer
 * square frame). Keeps the "tap the brand, go to the brand's
 * screen" cue from the framed version while reading as a single
 * punchy shape at header scale instead of a tiny triangle rattling
 * around inside a skinny-stroked box.
 *
 * The triangle fills the same 16×16 inner footprint that
 * `MultiIcon` uses for its 2×2 dot grid (both span x=4..20,
 * y=4..20 on the 24×24 viewBox), so when the two labeled pills
 * sit side-by-side in the header their glyphs carry matching
 * visual weight and the row reads as a consistent "MAIN MENU /
 * MULTIPLAYER" pair.
 *
 * Rendered monochrome in `currentColor` so the hover state on
 * `HomeButton` (border + glyph → accent) transitions the
 * triangle cleanly, instead of the favicon's cyan-on-black brand
 * palette which would fight the header's two-tone bone/ink theme.
 *
 * `shapeRendering="crispEdges"` matches the rest of the app's
 * brutalist glyph family (`MultiIcon`, the favicon itself). The
 * diagonal edges stair-step slightly at small sizes - same
 * trade-off the favicon makes, and the look it establishes.
 */
export function MenuIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      {/* Play triangle, bounding-box centered on the viewBox. The
          vertical midpoint of the tip (y=12) anchors it to the
          same optical center as `MultiIcon`'s 2×2 grid so the two
          glyphs sit on the same baseline when pilled side-by-side.
          Width and height both = 16, matching MultiIcon's 16×16
          footprint exactly. */}
      <polygon points="4,4 20,12 4,20" />
    </svg>
  );
}
