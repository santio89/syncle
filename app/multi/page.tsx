"use client";

/**
 * Multiplayer entry. Deliberately split:
 *
 *   - This file is the lightweight shell (header, intro copy, "How it works"
 *     steps, gradient bg). It contains no socket.io code, so the route
 *     chunk stays small and the page paints instantly when the user clicks
 *     "multi" from the homepage.
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

import { GradientBg } from "@/components/GradientBg";
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
      <p className="inline-flex w-fit items-center gap-2 border-2 border-yellow-400/70 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-yellow-400/90">
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
      <GradientBg />

      <header className="relative z-10 flex items-center justify-between gap-3 border-b-2 border-bone-50/15 px-4 py-3 sm:px-8 sm:py-4">
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
          className="group inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest text-bone-50/70 hover:text-accent transition-colors"
        >
          <ArrowIcon
            direction="left"
            size={13}
            strokeWidth={2.75}
            className="transition-transform duration-200 group-hover:-translate-x-0.5"
          />
          <span>Back</span>
        </button>
        <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-bone-50/50">
          Multiplayer
        </p>
        <ThemeToggle />
      </header>

      <div className="relative z-10 mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 pt-10 pb-16 sm:px-6 sm:pt-16">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-accent">
            ░ Up to 50 per room · same song, parallel runs
          </p>
          <h1 className="mt-2 font-display text-4xl font-bold leading-none sm:text-5xl">
            Pick a name and a room.
          </h1>
          <p className="mt-3 max-w-md text-sm text-bone-50/70">
            Create a fresh room and share the code, or join one a friend
            sent you. The host picks the song; everyone races on the same
            chart.
          </p>
        </div>

        <MultiEntryClient />

        <section className="space-y-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.35em] text-bone-50/45">
            ░ How it works
          </p>
          <ol className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Step n={1} title="Create">
              Pick a name, create a room, get a 6-character code.
            </Step>
            <Step n={2} title="Invite">
              Share the code. Up to 50 players per room.
            </Step>
            <Step n={3} title="Pick">
              Host chooses song and difficulty. Everyone loads it.
            </Step>
            <Step n={4} title="Race">
              Same chart, live scoreboard. Highest score wins.
            </Step>
          </ol>
        </section>
      </div>
    </main>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-3 border-2 border-bone-50/15 px-3 py-2.5">
      <span className="font-mono text-[10px] font-bold tracking-widest text-accent">
        0{n}
      </span>
      <div className="space-y-0.5">
        <p className="font-mono text-[11px] uppercase tracking-widest text-bone-50">
          {title}
        </p>
        <p className="text-[11px] leading-snug text-bone-50/60">{children}</p>
      </div>
    </li>
  );
}
