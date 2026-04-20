"use client";

/**
 * Multiplayer entry. Deliberately split:
 *
 *   - This file is the lightweight shell (header, intro copy, gradient bg).
 *     It contains no socket.io code, so the route chunk stays small and
 *     the page paints instantly when the user clicks "multi" from the
 *     homepage.
 *
 *   - `MultiEntryClient` owns the socket + form. We pull it in via
 *     `next/dynamic({ ssr: false })`, which puts socket.io-client and its
 *     transitive deps in their own chunk. While that chunk loads we render
 *     the `MultiEntryFallback` skeleton in place of the form so the page
 *     layout doesn't jump.
 *
 * Net effect: route navigation feels instant; the actual server handshake
 * (and any cold-start hint) shows up inside the page where the user can see
 * progress, instead of blocking the navigation itself.
 */

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { Suspense } from "react";

import { HomeButton } from "@/components/HomeButton";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ArrowIcon } from "@/components/icons/ArrowIcon";

// CRITICAL: keep the fallback inline in this file rather than importing it
// from MultiEntryClient. A static import (even of just the fallback symbol)
// would pull socket.io-client into the route's initial chunk through
// MultiEntryClient's module-top imports, defeating the whole code-split.
const MultiEntryClient = dynamic(
  () => import("@/components/multi/MultiEntryClient"),
  {
    ssr: false,
    loading: () => <MultiEntryFallback />,
  },
);

function MultiEntryFallback() {
  return (
    <>
      <p className="inline-flex w-fit items-center gap-2 border-2 border-yellow-400/70 px-3 py-1.5 font-mono text-[10.5px] uppercase tracking-widest text-yellow-400/90">
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-yellow-400" />
        Loading multiplayer…
      </p>
      <div className="brut-card space-y-4 p-5 sm:p-6">
        <div className="space-y-2">
          <div className="h-3 w-28 bg-bone-50/10" />
          <div className="h-10 w-full border-2 border-bone-50/15" />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="h-12 border-2 border-bone-50/15" />
          <div className="flex flex-col gap-2">
            <div className="h-10 border-2 border-bone-50/15" />
            <div className="h-12 border-2 border-bone-50/15" />
          </div>
        </div>
      </div>
    </>
  );
}

export default function MultiEntryPage() {
  const router = useRouter();

  return (
    <main className="relative min-h-screen overflow-hidden">
      {/* Padding kept in lockstep with the homepage / /play / room
          headers (px-4 sm:px-6 py-3) so the 38×38 icon-btn row
          produces the same overall header height on every page —
          previously this header was ~8px taller than the rest at
          sm:py-4 and ~16px wider on the sides at sm:px-8. */}
      <header className="relative z-10 flex items-center justify-between gap-3 border-b-2 border-bone-50/15 px-4 py-3 sm:px-6">
        <button
          onClick={() => {
            // Honor browser history so a player who landed here from the
            // homepage hop is taken back to it. If they hit /multi cold,
            // send them home as a sensible default.
            if (typeof window !== "undefined" && window.history.length > 1) {
              router.back();
            } else {
              router.push("/");
            }
          }}
          className="group inline-flex items-center gap-2 font-mono text-[11.5px] uppercase tracking-widest text-bone-50/70 hover:text-accent transition-colors"
        >
          <ArrowIcon
            direction="left"
            size={14}
            strokeWidth={2.75}
            className="transition-transform duration-200 group-hover:-translate-x-0.5"
          />
          <span>Back</span>
        </button>
        <p className="font-mono text-[10.5px] uppercase tracking-[0.4em] text-bone-50/50">
          Multiplayer
        </p>
        <div className="flex items-center gap-2 sm:gap-3">
          <HomeButton />
          <ThemeToggle />
        </div>
      </header>

      <div className="relative z-10 mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 pt-10 pb-16 sm:px-6 sm:pt-16">
        <div>
          <p className="font-mono text-[10.5px] uppercase tracking-[0.4em] text-accent">
            ░ Same song, parallel runs
          </p>
          <h1 className="mt-2 font-display text-[2.36rem] font-bold leading-none sm:text-[3.15rem]">
            Pick a name and a room.
          </h1>
          <p className="mt-3 max-w-md text-[0.92rem] text-bone-50/70">
            Create or join a room.
          </p>
        </div>

        {/* Suspense is required because MultiEntryClient calls
            useSearchParams() (to read `?code=…` when the room page
            redirects cold URL hits back here). Without it, Next would
            mark the route as fully dynamic / opt out of SSR for the
            whole tree. The dynamic-loaded fallback renders the same
            skeleton until the chunk is ready. */}
        <Suspense fallback={<MultiEntryFallback />}>
          <MultiEntryClient />
        </Suspense>
      </div>
    </main>
  );
}
