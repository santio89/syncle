"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { GradientBg } from "@/components/GradientBg";
import { loadSong } from "@/lib/game/chart";
import { SongMeta } from "@/lib/game/types";
import { bestKey, DailyBest, loadBest } from "@/lib/game/best";

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Derive a coarse difficulty label from note density. */
function difficultyLabel(noteCount: number, durationSec: number): string {
  if (durationSec <= 0) return "—";
  const nps = noteCount / durationSec;
  if (nps < 1.5) return "EASY";
  if (nps < 3) return "MEDIUM";
  if (nps < 5) return "HARD";
  return "EXPERT";
}

type LoadState =
  | { status: "loading" }
  | { status: "ready"; meta: SongMeta; noteCount: number }
  | { status: "error"; message: string };

export default function HomePage() {
  const todayLong = useMemo(
    () =>
      new Date().toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
      }),
    [],
  );
  const todayShort = useMemo(
    () =>
      new Date().toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      }),
    [],
  );

  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [yourBest, setYourBest] = useState<DailyBest | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadSong()
      .then((s) => {
        if (cancelled) return;
        setLoad({ status: "ready", meta: s.meta, noteCount: s.notes.length });
        // Pick the highest score across all difficulties for "your best".
        let highest: DailyBest | null = null;
        for (const m of ["easy", "normal", "hard"] as const) {
          const b = loadBest(bestKey(s.meta.id, m));
          if (b && (!highest || b.score > highest.score)) highest = b;
        }
        setYourBest(highest);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoad({
          status: "error",
          message: err?.message ?? "Could not load today's chart",
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="relative flex min-h-[100dvh] flex-col overflow-x-hidden">
      <GradientBg />

      <header className="relative z-10 flex shrink-0 items-center justify-between gap-4 border-b-2 border-bone-50/90 px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <svg
            viewBox="0 0 24 24"
            className="h-7 w-7 shrink-0 text-accent"
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
          <span className="font-mono text-xs tracking-[0.3em] text-bone-50/70">
            SYNCLE
          </span>
        </div>
        <nav className="flex items-center gap-6 font-mono text-xs uppercase tracking-widest text-bone-50/60">
          <span className="sm:hidden">{todayShort}</span>
          <span className="hidden sm:inline">{todayLong}</span>
        </nav>
      </header>

      <section className="relative z-10 mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 py-6 sm:gap-8 sm:px-6 lg:justify-center lg:py-8">
        <div className="grid grid-cols-1 items-center gap-6 md:grid-cols-[minmax(0,1fr)_auto] md:gap-12">
          <div className="flex min-w-0 flex-col gap-3">
            <span className="font-mono text-[10px] uppercase tracking-[0.35em] text-accent sm:text-[11px] sm:tracking-[0.4em]">
              ░ One song · One day · Endless retries
            </span>
            <h1 className="font-display whitespace-nowrap font-bold leading-[0.85] tracking-tight text-[clamp(2.75rem,15vw,9rem)]">
              SYNC<span className="text-accent">LE.</span>
            </h1>
            <p className="max-w-xl text-sm text-bone-50/80 sm:text-base">
              A new song every day. Hit the notes, hold the long ones, beat
              your own high score. Tomorrow it&rsquo;s a different track.
            </p>
          </div>

          <Link
            href="/play"
            aria-label="Play today's track"
            className="brut-play-cta flex h-32 w-full flex-row items-center justify-center gap-4 px-6 sm:aspect-square sm:h-auto sm:w-52 sm:flex-col sm:gap-1 sm:px-0 md:w-56 lg:w-64 xl:w-72 shrink-0 justify-self-center md:justify-self-end"
          >
            <span className="font-display text-6xl leading-none translate-x-[2px] sm:text-7xl sm:-translate-y-1 lg:text-8xl">
              ▶
            </span>
            <div className="flex flex-col items-start sm:items-center">
              <span className="font-display text-2xl font-bold tracking-[0.25em] sm:text-2xl lg:text-3xl">
                PLAY
              </span>
              {load.status === "ready" ? (
                <span className="font-mono text-[10px] uppercase tracking-widest opacity-70 truncate max-w-[12rem] sm:max-w-[90%]">
                  {load.meta.title} · {load.meta.artist}
                </span>
              ) : load.status === "loading" ? (
                <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest opacity-70">
                  <Spinner small dark />
                  <span>Loading track…</span>
                </span>
              ) : (
                <span className="font-mono text-[10px] uppercase tracking-widest opacity-70">
                  no chart found
                </span>
              )}
            </div>
          </Link>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <div className="brut-card-accent relative p-4 sm:p-5 md:col-span-2">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
              <div className="min-w-0">
                <p className="font-mono text-xs uppercase tracking-widest text-accent">
                  Today&rsquo;s track
                  {load.status === "ready" && (
                    <span className="ml-2 text-bone-50/40">· osu! 4K</span>
                  )}
                </p>

                {load.status === "ready" ? (
                  <>
                    <h2 className="mt-1 font-display text-2xl font-bold leading-tight truncate sm:text-3xl">
                      {load.meta.title}
                    </h2>
                    <p className="mt-0.5 text-sm text-bone-50/70 truncate">
                      {load.meta.artist}
                      {load.meta.year ? ` · ${load.meta.year}` : ""}
                    </p>
                  </>
                ) : load.status === "loading" ? (
                  <div className="mt-2 flex items-center gap-3">
                    <Spinner />
                    <div className="space-y-2">
                      <div className="h-7 w-44 animate-pulse bg-bone-50/10" />
                      <div className="h-3 w-28 animate-pulse bg-bone-50/10" />
                    </div>
                  </div>
                ) : (
                  <>
                    <h2 className="mt-1 font-display text-xl font-bold leading-tight text-rose-400 sm:text-2xl">
                      No chart available
                    </h2>
                    <p className="mt-0.5 font-mono text-xs text-bone-50/50 break-words">
                      {load.message}
                    </p>
                  </>
                )}
              </div>
              {load.status === "ready" && (
                <div className="flex shrink-0 flex-row gap-2 font-mono text-xs sm:flex-col sm:items-end sm:gap-1">
                  <span className="border-2 border-bone-50 px-2 py-0.5">
                    {formatDuration(load.meta.duration)}
                  </span>
                  <span className="border-2 border-accent px-2 py-0.5 text-accent">
                    {difficultyLabel(load.noteCount, load.meta.duration)}
                  </span>
                </div>
              )}
            </div>

            <div className="mt-4 flex items-end gap-3 sm:mt-5">
              <div className="flex h-10 flex-1 items-end gap-[2px] overflow-hidden sm:h-12 sm:gap-1">
                {Array.from({ length: 72 }).map((_, i) => {
                  const ready = load.status === "ready";
                  // Deterministic-but-irregular stagger so each bar pulses
                  // out of phase with its neighbors. Two coprime multipliers
                  // (47, 73) make the pattern look chaotic without RNG.
                  // Durations 1.4s–2.6s — slow breathing EQ, just a touch
                  // livelier than full ambient.
                  const delayMs = (i * 47) % 1800;
                  const durMs = 1400 + ((i * 73) % 1200);
                  return (
                    <div
                      key={i}
                      className={`flex-1 ${ready ? "bg-accent/70 waveform-bar" : "bg-bone-50/10"}`}
                      style={{
                        height: `${20 + Math.abs(Math.sin(i * 0.6)) * 80}%`,
                        opacity: 0.3 + (i % 5) * 0.15,
                        animationDelay: ready ? `${delayMs}ms` : undefined,
                        animationDuration: ready ? `${durMs}ms` : undefined,
                      }}
                    />
                  );
                })}
              </div>
              {load.status === "ready" ? (
                <Link
                  href="/play"
                  aria-label={`Play ${load.meta.title}`}
                  className="flex h-10 shrink-0 items-center gap-2 px-2 font-display text-sm font-bold tracking-widest text-bone-50 transition-opacity hover:opacity-80 sm:h-12"
                >
                  <span className="text-base leading-none">▶</span>
                  <span>PLAY</span>
                </Link>
              ) : (
                <span
                  aria-disabled
                  className="flex h-10 shrink-0 items-center gap-2 px-2 font-display text-sm font-bold tracking-widest text-bone-50/30 sm:h-12"
                >
                  <span className="text-base leading-none">▶</span>
                  <span>PLAY</span>
                </span>
              )}
            </div>
          </div>

          <div className="brut-card p-4 sm:p-5">
            <p className="font-mono text-xs uppercase tracking-widest text-bone-50/60">
              Global · live
            </p>
            <div className="mt-3 space-y-2 font-mono text-sm">
              <Stat label="players today" value="—" />
              <Stat label="top score" value="—" />
              <Stat
                label="your best"
                value={yourBest ? yourBest.score.toLocaleString() : "—"}
              />
              <Stat label="streak" value="0" />
            </div>
          </div>
        </div>
      </section>

      <footer className="relative z-10 shrink-0 border-t-2 border-bone-50/20 px-4 py-3 font-mono text-[10px] uppercase tracking-widest text-bone-50/40 sm:px-6 sm:text-[11px]">
        Syncle · Resets at midnight UTC · Online leaderboards & rooms soon
      </footer>
    </main>
  );
}

function Spinner({ small, dark }: { small?: boolean; dark?: boolean }) {
  const size = small ? 12 : 20;
  // `dark` flips the contrast for use on the bright blue play CTA.
  return (
    <span
      role="status"
      aria-label="Loading"
      className={`inline-block animate-spin rounded-full border-2 ${
        dark
          ? "border-ink-900/30 border-t-ink-900"
          : "border-bone-50/20 border-t-accent"
      }`}
      style={{ width: size, height: size }}
    />
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between border-b border-bone-50/10 pb-2">
      <span className="text-bone-50/50 uppercase text-[10px] tracking-widest">
        {label}
      </span>
      <span className="text-bone-50">{value}</span>
    </div>
  );
}
