"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { GradientBg } from "@/components/GradientBg";
import { MultiButton, MultiIcon } from "@/components/MultiButton";
import { StatusBadge } from "@/components/StatusBadge";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ArrowIcon } from "@/components/icons/ArrowIcon";
import {
  loadSong,
  displayMode,
  MODE_ORDER,
  prefetchAudio,
  type ModeAvailability,
} from "@/lib/game/chart";
import { SongMeta } from "@/lib/game/types";
import { bestKey, RunBest, loadBest } from "@/lib/game/best";
import { LifetimeStats, loadStats } from "@/lib/game/stats";

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

type LoadState =
  | { status: "loading" }
  | { status: "ready"; meta: SongMeta; noteCount: number; modes: ModeAvailability }
  | { status: "error"; message: string };

export default function HomePage() {
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  /**
   * Ref to the play CTA. Passed to `<GradientBg anchorRef={playRef} />`
   * so the gradient canvas centers itself on the CTA via JS measurement
   * (ResizeObserver + scroll/resize listeners), independent of layout.
   */
  const playRef = useRef<HTMLAnchorElement>(null);
  /** Lifetime best for the random song that just loaded (any mode). */
  const [trackBest, setTrackBest] = useState<RunBest | null>(null);
  /** All-time aggregates: tracks played, total runs, best ever. */
  const [stats, setStats] = useState<LifetimeStats>({
    totalRuns: 0,
    tracksPlayed: [],
    bestEver: null,
  });

  /**
   * Fetch + apply a random song. Shared by the initial mount effect
   * and the in-page refresh button.
   *
   * `force` controls the module-level session cache in chart.ts:
   *   - `false` (initial mount) → reuse any session already primed
   *     (e.g. from a back-nav or pre-warmed prefetch).
   *   - `true` (refresh button) → drop the cache and roll a brand-new
   *     random song without round-tripping through a full page reload.
   *
   * EAGER PREFETCH on homepage mount:
   *
   *   1. `loadSong()` downloads + extracts + parses the random .osz
   *      and runs `finalize()` for the default mode. The result is
   *      cached at module level (`sessionPromise` in chart.ts), so
   *      when the user later clicks Play and /play calls `loadSong()`
   *      again, the network + parse phase is skipped and only the
   *      ~ms-cheap quantization re-runs for whichever mode they
   *      picked. This means the picker on /play sees real per-tier
   *      availability on first paint instead of the all-disabled
   *      placeholder.
   *
   *   2. For LOCAL fallback songs (rare — only when every osu mirror
   *      fails), the audio lives at a separate URL and isn't bundled
   *      with the chart. We `prefetchAudio()` it so the browser HTTP
   *      cache is warm by the time the player hits Play. Remote .osz
   *      songs already have their decoded audio bytes sitting in the
   *      cached session, so no extra fetch is needed.
   */
  const fetchSong = useCallback(
    (force: boolean, signal: { cancelled: boolean }) => {
      setLoad({ status: "loading" });
      setTrackBest(null);
      loadSong(undefined, { force })
        .then((s) => {
          if (signal.cancelled) return;
          setLoad({
            status: "ready",
            meta: s.meta,
            noteCount: s.notes.length,
            modes: s.modes,
          });
          if (s.meta.audioUrl && !s.audioBytes) {
            prefetchAudio(s.meta.audioUrl);
          }
          // Highest score this device has ever set on this song, across all
          // difficulties — gives the player a target to chase on this refresh.
          let highest: RunBest | null = null;
          for (const m of MODE_ORDER) {
            const b = loadBest(bestKey(s.meta.id, m));
            if (b && (!highest || b.score > highest.score)) highest = b;
          }
          setTrackBest(highest);
        })
        .catch((err) => {
          if (signal.cancelled) return;
          setLoad({
            status: "error",
            message: err?.message ?? "Could not load a chart",
          });
        });
    },
    [],
  );

  /**
   * Latest in-flight signal for `fetchSong`. We keep it in a ref so
   * clicking refresh while a previous load is still pending cancels
   * the older response (instead of letting it race-overwrite the
   * newer state with a stale song).
   */
  const fetchSignalRef = useRef<{ cancelled: boolean } | null>(null);

  const refreshSong = useCallback(() => {
    if (fetchSignalRef.current) fetchSignalRef.current.cancelled = true;
    const signal = { cancelled: false };
    fetchSignalRef.current = signal;
    fetchSong(true, signal);
  }, [fetchSong]);

  useEffect(() => {
    setStats(loadStats());
    const signal = { cancelled: false };
    fetchSignalRef.current = signal;
    fetchSong(false, signal);
    return () => {
      signal.cancelled = true;
    };
  }, [fetchSong]);

  return (
    <main className="relative flex min-h-[100dvh] flex-col overflow-x-hidden">
      {/* GradientBg's wrapper fills <main> via `absolute inset-0`, the
          canvas fills the wrapper, and the cluster lives at
          JS-tracked pixel coordinates around the play CTA's center.
          Nothing in this stack has a hard pixel edge inside the
          viewport, so there's no cut to worry about. */}
      <GradientBg anchorRef={playRef} />

      <header className="relative z-10 flex shrink-0 items-center justify-between gap-4 border-b-2 border-bone-50/90 px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
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
          {/* Wordmark mirrors the H1 hero coloring exactly: SYNC pops
              to the full theme foreground (cream in dark, near-black
              in light), LE picks up the accent. The outer span's
              `text-bone-50/70` would dim the brand mark; overriding
              SYNC back to a non-alpha `text-bone-50` keeps it at the
              same weight it has in the H1, instead of looking like
              washed-out caption text next to the icon. */}
          <span className="font-mono text-[0.79rem] tracking-[0.3em] text-bone-50/70">
            <span className="text-bone-50">SYNC</span>
            <span className="text-accent">LE</span>
          </span>
        </div>
        <nav className="flex items-center gap-3 font-mono text-[0.79rem] uppercase tracking-widest text-bone-50/60">
          {/* All header chips share `.icon-btn` (38×38 square) so the
              right side of the header reads as a uniform strip. The
              old wider "░ multi" pill drifted off-grid; the icon-only
              MultiButton keeps the rhythm with ThemeToggle. Tooltip
              still spells out "Multiplayer · up to 50 players per
              room" so the affordance isn't lost with the label. */}
          <MultiButton />
          <ThemeToggle />
        </nav>
      </header>

      <section className="relative z-10 mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 py-6 sm:gap-8 sm:px-6 lg:justify-center lg:py-8">
        <div className="grid grid-cols-1 items-center gap-6 md:grid-cols-[minmax(0,1fr)_auto] md:gap-12">
          <div className="flex min-w-0 flex-col gap-3">
            <span className="font-mono text-[10.5px] uppercase tracking-[0.35em] text-accent sm:text-[11.5px] sm:tracking-[0.4em]">
              ░ Random song · Endless retries
            </span>
            <h1 className="font-display whitespace-nowrap font-bold leading-[0.85] tracking-tight text-[clamp(2.9rem,15.75vw,9.45rem)]">
              SYNC<span className="text-accent">LE</span>
            </h1>
            <p className="max-w-xl text-[0.92rem] text-bone-50/80 sm:text-[1.05rem]">
              A fresh osu!mania track every refresh. Hit the notes, hold the
              long ones, push your best. Refresh for a new one.
            </p>
          </div>

          <Link
            ref={playRef}
            href="/play"
            aria-label="Play this track"
            // Custom tooltip (TooltipLayer) showing full title + artist
            // when the ellipsized text doesn't tell the whole story.
            // `\n` is honored by `.brut-tooltip { white-space: pre-line }`,
            // so each field renders on its own row.
            data-tooltip={
              load.status === "ready"
                ? `Song: ${load.meta.title}\nArtist: ${load.meta.artist}`
                : undefined
            }
            // `relative z-10` keeps the CTA above the GradientBg canvas,
            // which is `pointer-events-none absolute inset-0` on <main>
            // and JS-positioned to center on this very element.
            className="brut-play-cta relative z-10 flex h-[8.4rem] w-full flex-row items-center justify-center gap-4 px-6 sm:aspect-square sm:h-auto sm:w-[13.65rem] sm:flex-col sm:gap-1 sm:px-4 md:w-[14.7rem] lg:w-[16.8rem] xl:w-[18.9rem] shrink-0 justify-self-center md:justify-self-end"
          >
            <span className="font-display text-[3.95rem] leading-none translate-x-[2px] sm:text-[4.75rem] sm:-translate-y-1 lg:text-[6.3rem] shrink-0">
              ▶
            </span>
            {/* min-w-0 + flex-1 (mobile) / w-full (desktop) is what unlocks
             *  truncation inside this flex parent — without min-w-0 the flex
             *  child defaults to min-width:auto and refuses to shrink. */}
            <div className="flex min-w-0 flex-1 flex-col items-start text-left sm:w-full sm:flex-none sm:items-center sm:text-center">
              <span className="font-display text-[1.6rem] font-bold tracking-[0.25em] sm:text-[1.6rem] lg:text-[1.95rem]">
                PLAY
              </span>
              {load.status === "ready" ? (
                <span className="block w-full max-w-full">
                  <span className="block w-full truncate font-mono text-[11.5px] font-bold uppercase tracking-widest opacity-90">
                    {load.meta.title}
                  </span>
                  <span className="block w-full truncate font-mono text-[10.5px] uppercase tracking-wider opacity-60">
                    {load.meta.artist}
                  </span>
                </span>
              ) : load.status === "loading" ? (
                <span className="flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-widest opacity-70">
                  <Spinner small dark />
                  <span>Loading track…</span>
                </span>
              ) : (
                <span className="font-mono text-[10.5px] uppercase tracking-widest opacity-70">
                  no chart available
                </span>
              )}
            </div>
          </Link>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <div
            // `flex flex-col` + `mt-auto` on the waveform row pins the
            // waveform/PLAY controls to the bottom edge of the card.
            // Without this they hug the title block and leave the
            // bottom half of the cover image as empty padding — bad
            // composition, especially with anime keyart covers whose
            // subjects sit center/lower. The card height comes from
            // grid `stretch` matching the stats card on the right.
            className="brut-card-accent relative flex flex-col overflow-hidden p-4 sm:p-5 md:col-span-2"
            style={
              load.status === "ready" && load.meta.coverUrl
                ? {
                    // Theme-aware overlay. Tints the cover with the
                    // page's BASE color (`--bg`: cream in light mode,
                    // near-black in dark mode) so the dim layer
                    // becomes a "lighter wash" or a "darker wash"
                    // depending on theme — text below it always sits
                    // on a surface tinted toward the active theme,
                    // which means the regular themed `--fg` text
                    // color (inherited from <body>) reads naturally
                    // without needing to lock the card to one theme.
                    //
                    // Two layers:
                    //   1. Left-weighted directional gradient — the
                    //      title/artist column lives on the left, so
                    //      it gets the heaviest wash. Right side
                    //      stays lighter to let the cover breathe
                    //      near the duration badge.
                    //   2. Flat dim across the whole card so bright
                    //      cover highlights can't punch through and
                    //      fight the text for contrast.
                    //
                    // 404s silently fall back to the card's own
                    // translucent surface from `.brut-card-accent`.
                    backgroundImage: `linear-gradient(90deg, rgb(var(--bg) / 0.90) 0%, rgb(var(--bg) / 0.65) 50%, rgb(var(--bg) / 0.30) 100%), linear-gradient(rgb(var(--bg) / 0.22), rgb(var(--bg) / 0.22)), url(${load.meta.coverUrl})`,
                    backgroundSize: "cover",
                    backgroundPosition: "center",
                  }
                : undefined
            }
          >
            <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
              <div
                className="min-w-0 flex-1"
                data-tooltip={
                  load.status === "ready"
                    ? `Song: ${load.meta.title}\nArtist: ${load.meta.artist}${
                        load.meta.year ? `\nYear: ${load.meta.year}` : ""
                      }`
                    : undefined
                }
              >
                <p className="flex flex-wrap items-center gap-2 font-mono text-[0.78rem] uppercase tracking-widest text-accent">
                  <span>Now playing</span>
                  {load.status === "ready" && (
                    <span className="text-bone-50/40">· osu! 4K</span>
                  )}
                  {load.status === "ready" && load.meta.status && (
                    <StatusBadge status={load.meta.status} size="xs" />
                  )}
                </p>

                {load.status === "ready" ? (
                  <>
                    <h2
                      className="mt-1 block w-full truncate font-display text-[1.55rem] font-bold leading-tight sm:text-[1.95rem]"
                      style={
                        load.meta.coverUrl
                          ? {
                              // Halo using the page base color, so in
                              // light mode it's a cream glow around
                              // the dark title (lifts it off bright
                              // cover highlights) and in dark mode
                              // it's a black glow around the bone
                              // title (same idea, inverted).
                              textShadow: "0 2px 10px rgb(var(--bg) / 0.95)",
                            }
                          : undefined
                      }
                    >
                      {load.meta.title}
                    </h2>
                    <p
                      className="mt-0.5 block w-full truncate text-[0.92rem]"
                      style={
                        load.meta.coverUrl
                          ? {
                              color: "rgb(var(--fg) / 0.85)",
                              textShadow: "0 1px 6px rgb(var(--bg) / 0.95)",
                            }
                          : { color: "rgb(var(--fg) / 0.85)" }
                      }
                    >
                      {load.meta.artist}
                      {load.meta.year ? ` · ${load.meta.year}` : ""}
                    </p>
                    {/* Duration sits as a quiet metadata line under the
                        artist — no border, no padding, just the same
                        muted-mono treatment used for other secondary
                        details (year, mapper, etc. when shown). The
                        old bordered chip in the bottom-right corner
                        above the PLAY CTA was visually competing with
                        the CTA; demoting it to inline metadata lets
                        the PLAY button stand on its own. */}
                    <p
                      className="mt-1 font-mono text-[0.78rem] uppercase tracking-widest text-bone-50/55"
                      style={
                        load.meta.coverUrl
                          ? { textShadow: "0 1px 6px rgb(var(--bg) / 0.95)" }
                          : undefined
                      }
                    >
                      {formatDuration(load.meta.duration)}
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
                    <h2 className="mt-1 font-display text-[1.31rem] font-bold leading-tight text-rose-400 sm:text-[1.58rem]">
                      No chart available
                    </h2>
                    <p className="mt-0.5 font-mono text-[0.79rem] text-bone-50/50 break-words">
                      {load.message}
                    </p>
                  </>
                )}
              </div>
              {/* Right rail of the now-playing header now carries
                  ONLY the "roll a new random track" refresh button —
                  the duration chip moved down to sit above the PLAY
                  CTA in the bottom row, where it visually belongs
                  (it describes the thing you're about to play). The
                  refresh button stays here, alongside the song
                  metadata, because it's a "metadata-level" action
                  (swap THIS song) rather than a play-level action.
                  Card no longer carries a difficulty badge either:
                  with adaptive quantization every song exposes Easy
                  through some path (mapper-shipped or synthesized
                  from the densest source), so a single label can't
                  summarize the song's range. The full picker on
                  /play is the source of truth for which tiers are
                  actually available. */}
              <div className="flex shrink-0 items-center font-mono text-[0.78rem]">
                <RefreshSongButton
                  onClick={refreshSong}
                  loading={load.status === "loading"}
                />
              </div>
            </div>

            <div className="mt-auto flex items-end gap-3 pt-5">
              <div className="flex h-[2.6rem] flex-1 items-end gap-[2px] overflow-hidden sm:h-[3.15rem] sm:gap-1">
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
              {/* PLAY CTA — duration moved out of this stack and
                  back up under the artist line as inline metadata,
                  so the bottom-right corner is just the play action
                  itself, free of competing chips. The PLAY link
                  shrink-wraps to its natural type metrics; the
                  waveform to the left owns the row height via its
                  own `h-[3.15rem]` and `items-end` on the parent
                  keeps PLAY bottom-aligned with the waveform. */}
              {load.status === "ready" ? (
                <Link
                  href="/play"
                  aria-label={`Play ${load.meta.title}`}
                  className="inline-flex shrink-0 items-center gap-2 border-2 border-bone-50 px-3 py-1.5 font-display text-[0.92rem] font-bold tracking-widest text-bone-50 transition-colors hover:border-accent hover:text-accent"
                >
                  <span className="text-[1.05rem] leading-none">▶</span>
                  <span>PLAY</span>
                </Link>
              ) : (
                <span
                  aria-disabled
                  className="inline-flex shrink-0 items-center gap-2 border-2 border-bone-50/30 px-3 py-1.5 font-display text-[0.92rem] font-bold tracking-widest text-bone-50/30"
                >
                  <span className="text-[1.05rem] leading-none">▶</span>
                  <span>PLAY</span>
                </span>
              )}
            </div>
          </div>

          <div className="brut-card p-4 sm:p-5">
            <p className="font-mono text-[0.78rem] uppercase tracking-widest text-bone-50/60">
              Your stats
            </p>
            <div className="mt-3 space-y-2 font-mono text-[0.92rem]">
              <Stat
                label="tracks played"
                value={stats.tracksPlayed.length.toLocaleString()}
              />
              <Stat
                label="total runs"
                value={stats.totalRuns.toLocaleString()}
              />
              <Stat
                label="best on this track"
                value={trackBest ? trackBest.score.toLocaleString() : "—"}
              />
              <Stat
                label="all-time best"
                value={
                  stats.bestEver ? stats.bestEver.score.toLocaleString() : "—"
                }
                hint={
                  stats.bestEver
                    ? `${stats.bestEver.songTitle} · ${displayMode(stats.bestEver.mode)}`
                    : undefined
                }
              />
            </div>
          </div>
        </div>
      </section>

      <footer className="relative z-10 flex shrink-0 flex-wrap items-center justify-between gap-3 border-t-2 border-bone-50/20 px-4 py-3 font-mono text-[10.5px] uppercase tracking-widest text-bone-50/40 sm:px-6 sm:text-[11.5px]">
        {/* SYNC + accent LE wordmark mirrors the H1 hero coloring;
            the trailing "· Random song · Endless retries" caption is
            bumped to /60 so it sits at the same visual weight as the
            "MULTIPLAYER ROOMS" link on the right side of the footer.
            Without the override it inherited the footer parent's /40
            and looked noticeably dimmer than its right-side
            counterpart, leaving the row visually unbalanced. */}
        <span>
          <span className="text-bone-50">SYNC</span>
          <span className="text-accent">LE</span>
          <span className="text-bone-50/60"> · Random song · Endless retries</span>
        </span>
        {/* Same MultiIcon + ArrowIcon vocabulary as the header buttons
            (Back / Join room / Start) — the loose `░` unicode glyph
            and `→` character were the last holdouts from the early
            "ascii-art" era and didn't match the sharper SVG icons
            elsewhere. The arrow gets the same group-hover translate
            we use everywhere a forward action sits in a row. */}
        <Link
          href="/multi"
          className="group inline-flex items-center gap-2 text-bone-50/60 hover:text-accent transition-colors"
          data-tooltip="Multiplayer"
        >
          {/* MultiIcon bumped from 11→14 (and the trailing arrow from
              12→14 to keep the row balanced) — at 11px the four
              squares were getting muddy at this footer text size,
              now they read as four distinct players at a glance. */}
          <MultiIcon size={14} />
          <span>multiplayer rooms</span>
          <ArrowIcon
            direction="right"
            size={14}
            strokeWidth={2.75}
            className="transition-transform duration-200 group-hover:translate-x-0.5"
          />
        </Link>
      </footer>
    </main>
  );
}

function Spinner({ small, dark }: { small?: boolean; dark?: boolean }) {
  const size = small ? 13 : 21;
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

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  /** Optional small subline below the row (e.g. song title for all-time best). */
  hint?: string;
}) {
  return (
    <div className="border-b border-bone-50/10 pb-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-bone-50/50 uppercase text-[10.5px] tracking-widest">
          {label}
        </span>
        <span className="text-bone-50 tabular-nums">{value}</span>
      </div>
      {hint && (
        <div
          className="mt-0.5 truncate text-right text-[9.5px] uppercase tracking-widest text-bone-50/30"
          data-tooltip={hint}
        >
          {hint}
        </div>
      )}
    </div>
  );
}

/**
 * Compact "roll a new random track" button used in the home page's
 * now-playing card. Sits beside the duration chip and lets the
 * player swap to a fresh random song without a full-page reload —
 * which would also discard any prefetched audio in other tabs and
 * blank the canvas, the gradient, etc.
 *
 * Visually borrows the brutalist chip recipe (`border-2`, square
 * corners, monospace caps inside) so it reads as a sibling of the
 * duration chip rather than competing with the PLAY CTA above.
 * Spins the icon while the new song is fetching so the player has
 * an honest indicator that something's happening — clicking again
 * mid-fetch is harmless (the page-level handler cancels the older
 * in-flight signal so only the freshest response wins).
 */
function RefreshSongButton({
  onClick,
  loading,
}: {
  onClick: () => void;
  loading: boolean;
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
      className="group inline-flex items-center gap-1.5 border-2 border-accent bg-transparent px-2 py-1 font-mono text-[10.5px] font-bold leading-none uppercase tracking-widest text-accent transition-colors hover:bg-accent/10 disabled:cursor-wait disabled:opacity-60"
      data-tooltip="Roll a new random track"
      aria-label="Roll a new random track"
      aria-busy={loading}
    >
      {/* Unicode ↻ glyph instead of an SVG so this button matches
          the browser-lobby's "↻ refresh" affordance one-for-one
          — two surfaces, same icon, no inconsistency. The glyph
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
