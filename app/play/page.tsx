"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ArrowIcon } from "@/components/icons/ArrowIcon";

// Game uses browser-only APIs (AudioContext, Canvas), so render client-side.
// Keeping the page itself "use client" too — mixing a server page that both
// imports a client component AND uses next/dynamic({ssr:false}) intermittently
// breaks the React Client Manifest (we saw this happen with ThemeToggle).
//
// `loading:` is critical: Game.tsx pulls in the audio engine, renderer,
// song-fetch layer, and beatmap parser, so its chunk takes a beat to come
// down on a cold cache. Without a fallback the route paints an empty body
// during that window, which reads as "the page didn't load". With it the
// shell + spinner appear instantly and the canvas swaps in when ready.
const Game = dynamic(() => import("@/components/Game"), {
  ssr: false,
  loading: () => <GameSkeleton />,
});

export default function PlayPage() {
  return (
    <main className="relative flex h-screen w-screen flex-col overflow-hidden bg-ink-900">
      {/* Slim top bar */}
      <header className="z-30 flex items-center justify-between gap-3 border-b-2 border-bone-50/20 px-4 py-2">
        <Link
          href="/"
          className="group inline-flex items-center gap-2 font-mono text-xs uppercase tracking-widest text-bone-50/70 transition-colors hover:text-accent"
        >
          <ArrowIcon
            direction="left"
            size={14}
            strokeWidth={2.75}
            className="transition-transform duration-200 group-hover:-translate-x-0.5"
          />
          <span>Syncle</span>
        </Link>
        <div className="flex items-center gap-2 sm:gap-3">
          <span className="hidden font-mono text-[10px] uppercase tracking-[0.3em] text-bone-50/40 sm:inline">
            Single player · v0.2
          </span>
          <ThemeToggle />
        </div>
      </header>

      <div className="relative flex-1">
        <Game />
      </div>
    </main>
  );
}

/**
 * Placeholder shown while the Game chunk is still downloading. Matches the
 * dark canvas backdrop so the swap-in is invisible — the user just sees a
 * spinner appear in the middle of the dark area, then the highway lights up.
 */
function GameSkeleton() {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-ink-900">
      <span
        aria-hidden
        className="inline-block h-7 w-7 animate-spin rounded-full border-2 border-bone-50/15 border-t-accent"
      />
      <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-bone-50/45">
        Loading game…
      </p>
    </div>
  );
}
