"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { HomeButton } from "@/components/HomeButton";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ArrowIcon } from "@/components/icons/ArrowIcon";
import { useAttemptLeave } from "@/components/LeaveGuardProvider";

// Game uses browser-only APIs (AudioContext, Canvas), so render client-side.
// Keeping the page itself "use client" too - mixing a server page that both
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
  const router = useRouter();
  const attemptLeave = useAttemptLeave();
  return (
    <main className="relative flex h-screen w-screen flex-col overflow-hidden bg-ink-900">
      {/* Slim top bar */}
      {/* Padding kept in lockstep with the homepage and /multi headers
          (px-4 sm:px-6 py-3) so the 38×38 icon-btn row produces the
          same overall header height on every page. Diverging here
          shaved ~8px off the bar and made the gameplay viewport jump
          when navigating between pages. */}
      <header className="z-30 flex items-center justify-between gap-3 border-b-2 border-bone-50/20 px-4 py-3 sm:px-6">
        <Link
          href="/"
          // Routed through the global LeaveGuardProvider so an
          // active solo run surfaces the "Are you sure?" prompt
          // before the navigation runs. Pass-through when no run
          // is in progress (idle / loading / results phases).
          onClick={(e) => {
            e.preventDefault();
            // router.replace so the LeaveGuardProvider can collapse
            // the /play entry out of history alongside its sentinel.
            // Pressing browser back from / would otherwise re-mount
            // /play and re-roll a fresh random song mid-action,
            // which feels like a back-button loop.
            attemptLeave(() => router.replace("/"));
          }}
          className="group inline-flex items-center gap-2 font-mono text-[0.79rem] uppercase tracking-widest text-bone-50/70 transition-colors hover:text-accent"
        >
          <ArrowIcon
            direction="left"
            size={15}
            strokeWidth={2.75}
            className="transition-transform duration-200 group-hover:-translate-x-0.5"
          />
          <span>Syncle</span>
        </Link>
        {/* Center cluster - mirrors the /multi header (room code +
            ConnectionPill in the middle slot). The page title sits
            here so the bar reads back-button · title · controls
            on every screen. Hidden on <sm because the back link +
            home + theme already crowd the row on a 320px viewport
            and the title is redundant with the URL there. */}
        <div className="hidden flex-1 items-center justify-center sm:flex">
          <span className="font-mono text-[10.5px] uppercase tracking-[0.3em] text-bone-50/40">
            Single player
          </span>
        </div>
        <div className="flex items-center gap-2 sm:gap-3">
          <HomeButton />
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
 * dark canvas backdrop so the swap-in is invisible - the user just sees a
 * spinner appear in the middle of the dark area, then the highway lights up.
 */
function GameSkeleton() {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-ink-900">
      <span
        aria-hidden
        className="inline-block h-[1.84rem] w-[1.84rem] animate-spin rounded-full border-2 border-bone-50/15 border-t-accent"
      />
      <p className="font-mono text-[10.5px] uppercase tracking-[0.4em] text-bone-50/45">
        Loading game…
      </p>
    </div>
  );
}
