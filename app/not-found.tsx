import Link from "next/link";

import { ArrowIcon } from "@/components/icons/ArrowIcon";

/**
 * App-wide 404 page. Next.js renders this whenever a route doesn't match
 * (or when a server component calls `notFound()`), wrapped in the same
 * RootLayout as everything else - meaning the global theme variables,
 * brutalist tokens, and TooltipLayer are already in scope.
 *
 * The default Next.js 404 (small "404" + "This page could not be found")
 * looks generic and breaks the brutalist visual language the rest of the
 * app commits to. This replacement mirrors the landing page's structure
 * (logo + wordmark header on top, single dominant card in the middle)
 * so a mistyped URL still feels like part of Syncle, not a system error.
 *
 * Implemented as a plain server component:
 *   - No client-only APIs (no router events, no theme reads - the
 *     CSS-driven theme tokens already adapt the surface to dark/light).
 *   - The single CTA is a `next/link` → no JavaScript required to
 *     bounce back to the landing page.
 */
export default function NotFound() {
  return (
    <main className="relative flex min-h-[100dvh] flex-col overflow-x-hidden">
      {/* Header is a stripped-down version of the landing-page header:
          same icon + SYNC|LE wordmark on the left, no nav chips on the
          right (since there's nothing meaningful to link to from a
          dead URL - "back to home" lives as the primary CTA below).
          The bottom border is the same `border-bone-50/90` brutalist
          rule used everywhere else, so the page still feels framed
          even without right-side controls. */}
      <header className="relative z-10 flex shrink-0 items-center justify-between gap-4 border-b-2 border-bone-50/90 px-4 py-3 sm:px-6">
        <Link
          href="/"
          aria-label="Back to Syncle home"
          data-tooltip="Back to home"
          className="flex min-w-0 items-center gap-3 outline-none focus-visible:opacity-80"
        >
          <svg
            viewBox="0 0 24 24"
            className="h-[1.84rem] w-[1.84rem] shrink-0 text-accent"
            shapeRendering="crispEdges"
            aria-hidden="true"
          >
            <rect
              x="1"
              y="1"
              width="22"
              height="22"
              fill="currentColor"
              fillOpacity="0.2"
              stroke="currentColor"
              strokeWidth="2"
            />
            <polygon points="10,7.5 16.5,12 10,16.5" fill="currentColor" />
          </svg>
          <span className="font-mono text-[0.79rem] tracking-[0.3em] text-bone-50/70">
            <span className="text-bone-50">SYNC</span>
            <span className="text-accent">LE</span>
          </span>
        </Link>
      </header>

      {/* Centered single-card layout. `flex-1` + `justify-center` keeps
          the card optically centered between header and footer at every
          viewport height; `max-w-2xl` caps line length on ultrawide
          monitors so the message doesn't sprawl across 1600 px of empty
          surface. */}
      <section className="relative z-10 mx-auto flex w-full max-w-2xl flex-1 flex-col items-stretch justify-center gap-6 px-4 py-10 sm:gap-8 sm:px-6 sm:py-14">
        <div className="brut-card-accent flex flex-col gap-6 p-6 sm:gap-8 sm:p-10">
          {/* Brand stamp - same icon + SYNC|LE wordmark used in
              the header / footer, anchored at the top of the card
              so the 404 message reads like an in-app moment instead
              of a generic system page. The icon and wordmark sizes
              are bumped slightly above the header treatment so the
              mark sits comfortably on the larger card surface
              without looking like a tiny header reused at the wrong
              scale. */}
          <div className="flex items-center gap-3">
            <svg
              viewBox="0 0 24 24"
              className="h-[2.1rem] w-[2.1rem] shrink-0 text-accent"
              shapeRendering="crispEdges"
              aria-hidden="true"
            >
              <rect
                x="1"
                y="1"
                width="22"
                height="22"
                fill="currentColor"
                fillOpacity="0.2"
                stroke="currentColor"
                strokeWidth="2"
              />
              <polygon points="10,7.5 16.5,12 10,16.5" fill="currentColor" />
            </svg>
            <span className="font-mono text-[0.92rem] tracking-[0.3em] text-bone-50/70">
              <span className="text-bone-50">SYNC</span>
              <span className="text-accent">LE</span>
            </span>
          </div>

          {/* Hero pair: chunky 404 numeral on the left, brutalist
              vertical rule, descriptive copy on the right. The
              numeral uses the same `font-display` clamp as the
              SYNCLE wordmark on the landing page (just a different
              ceiling) so the brand voice stays loud. The copy
              column is `min-w-0` so the heading wraps cleanly on
              narrow viewports without pushing the rule sideways. */}
          <div className="flex flex-col gap-5 sm:flex-row sm:items-stretch sm:gap-7">
            <p className="font-display text-[clamp(4.2rem,18vw,7.5rem)] font-bold leading-[0.85] tracking-tight text-bone-50">
              4<span className="text-accent">0</span>4
            </p>
            <div
              aria-hidden="true"
              className="hidden w-px shrink-0 bg-bone-50/25 sm:block"
            />
            <div className="flex min-w-0 flex-1 flex-col justify-center gap-3">
              <h1 className="font-display text-[1.65rem] font-bold leading-tight text-bone-50 sm:text-[2rem]">
                Page not found.
              </h1>
              <p className="text-[0.95rem] text-bone-50/75 sm:text-[1.05rem]">
                The track you were looking for has left the highway.
                Hit home and we&apos;ll roll a fresh song for you.
              </p>
            </div>
          </div>

          {/* Primary CTA - `brut-btn` shares the brutalist border
              + hover-fill recipe used by every other accent button
              in the app. The arrow nudges right on hover (same
              200 ms slide as the multi "Join" / lobby buttons), so
              the affordance reads as "go forward" rather than
              "submit form". `group` is what wires the arrow's
              translate to the parent's hover state. */}
          <div className="flex flex-wrap items-center gap-3">
            <Link
              href="/"
              className="brut-btn group inline-flex items-center gap-2 px-4 py-2.5 font-mono text-[11.5px] uppercase tracking-widest"
              aria-label="Back to Syncle home"
              data-tooltip="Back to home"
            >
              <span>Back to home</span>
              <ArrowIcon
                direction="right"
                size={14}
                strokeWidth={2.75}
                className="transition-transform duration-200 group-hover:translate-x-0.5"
              />
            </Link>
          </div>
        </div>
      </section>

      {/* Footer kept ultra-light: just a single attribution line so
          the page has a closing edge instead of trailing into the
          viewport bottom. Mirrors the landing-page footer rhythm
          (same border + padding + font), minus the multi/refresh
          chips which don't make sense on a 404. */}
      <footer className="relative z-10 mt-auto flex shrink-0 items-center justify-between gap-3 border-t-2 border-bone-50/90 px-4 py-3 font-mono text-[10.5px] uppercase tracking-widest text-bone-50/55 sm:px-6">
        <span>
          <span className="text-bone-50">SYNC</span>
          <span className="text-accent">LE</span>
        </span>
        <span aria-hidden="true">404 · off the highway</span>
      </footer>
    </main>
  );
}

export const metadata = {
  title: "404 · SYNCLE",
  description:
    "This Syncle page doesn't exist. Head back to home for a fresh track.",
};
