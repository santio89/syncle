"use client";

/**
 * "Waiting for X / N players" screen during the loading phase. Shows a
 * shared progress message (whatever the local download/extraction is doing)
 * and a per-player ready state grid. Counts down toward the server-side
 * deadline so people can see the timeout coming.
 */

import { useEffect, useState } from "react";

import type { ChartMode } from "@/lib/game/chart";
import { displayMode } from "@/lib/game/chart";
import type { RoomSnapshot } from "@/lib/multi/protocol";

export function LoadingScreen({
  snapshot,
  progress,
  error,
  isHost,
  mode,
  deadline,
  onCancel,
}: {
  snapshot: RoomSnapshot;
  progress: string | null;
  error: string | null;
  isHost: boolean;
  mode: ChartMode | null;
  deadline: number | null;
  onCancel: () => void;
}) {
  const total = snapshot.players.filter((p) => p.online).length;
  const ready = snapshot.players.filter((p) => p.online && p.ready).length;
  const song = snapshot.selectedSong;
  const remaining = useDeadlineCountdown(deadline);

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.4fr)_1fr]">
      <div className="brut-card flex flex-col gap-4 p-5 sm:p-7">
        <p className="font-mono text-[10.5px] uppercase tracking-[0.4em] text-accent">
          ░ Loading
        </p>
        {song ? (
          <h2
            className="truncate font-display text-[1.97rem] font-bold sm:text-[2.36rem]"
            title={`${song.artist} — ${song.title}`}
          >
            {song.title}
          </h2>
        ) : (
          <h2 className="font-display text-[1.97rem] font-bold sm:text-[2.36rem]">—</h2>
        )}
        {song && (
          <p className="-mt-2 truncate text-bone-50/70" title={song.artist}>
            {song.artist}
            {mode && (
              <span className="ml-2 font-mono text-[10.5px] uppercase tracking-widest text-bone-50/40">
                · {displayMode(mode)}
              </span>
            )}
          </p>
        )}

        <div className="border-2 border-bone-50/20 px-3 py-2">
          <p className="font-mono text-[10.5px] uppercase tracking-widest text-bone-50/50">
            Your client
          </p>
          {error ? (
            <p className="mt-0.5 font-mono text-[0.92rem] text-rose-400">
              ✕ {error} — waiting on the others, or hit cancel
            </p>
          ) : progress ? (
            <p className="mt-0.5 flex items-center gap-2 font-mono text-[0.92rem] text-bone-50/85">
              <Spinner />
              <span className="truncate" title={progress}>
                {progress}
              </span>
            </p>
          ) : (
            <p className="mt-0.5 flex items-center gap-2 font-mono text-[0.92rem] text-accent">
              <span className="inline-block h-2 w-2 bg-accent" />
              ready — waiting for the room
            </p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2 font-mono text-[0.79rem]">
          <Stat label="ready" value={`${ready} / ${total}`} accent />
          <Stat
            label="deadline"
            value={remaining !== null ? `${Math.ceil(remaining / 1000)}s` : "—"}
            // Tint the deadline value as time runs short so the room can
            // feel the pressure: amber under 10s, red + pulsing under 5s.
            // The pulse is the "GAME WILL START" arcade urgency cue —
            // people instantly know to nudge a struggling teammate.
            tone={
              remaining === null
                ? "neutral"
                : remaining < 5000
                  ? "danger"
                  : remaining < 10000
                    ? "warn"
                    : "neutral"
            }
            pulse={remaining !== null && remaining < 5000}
          />
        </div>

        {isHost && (
          <button
            onClick={onCancel}
            className="brut-btn mt-2 self-start px-4 py-2 text-[0.79rem]"
          >
            ✕ Cancel back to lobby
          </button>
        )}
      </div>

      {/* Per-player readiness grid */}
      <div className="brut-card p-5 sm:p-6">
        <p className="font-mono text-[10.5px] uppercase tracking-[0.4em] text-accent">
          ░ Players
        </p>
        <ul className="mt-3 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {snapshot.players.map((p) => {
            const status = !p.online
              ? "offline"
              : p.ready
                ? "ready"
                : "loading";
            return (
              <li
                key={p.id}
                className={`flex items-center gap-2 border-2 px-3 py-2 font-mono text-[0.79rem] transition-colors ${
                  status === "ready"
                    ? "border-accent text-accent"
                    : status === "offline"
                      ? "border-bone-50/10 text-bone-50/30"
                      : "border-bone-50/20 text-bone-50/70"
                }`}
              >
                <span
                  className={`inline-block h-1.5 w-1.5 rounded-full ${
                    status === "ready"
                      ? "bg-accent"
                      : status === "offline"
                        ? "bg-bone-50/20"
                        : "bg-yellow-400 animate-pulse"
                  }`}
                />
                <span className="flex-1 truncate">{p.name}</span>
                <span className="font-mono text-[9.5px] uppercase tracking-widest opacity-70">
                  {status}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

type StatTone = "neutral" | "warn" | "danger";

function Stat({
  label,
  value,
  accent,
  tone = "neutral",
  pulse = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
  tone?: StatTone;
  pulse?: boolean;
}) {
  const valueClass = accent
    ? "text-accent"
    : tone === "danger"
      ? "text-rose-400"
      : tone === "warn"
        ? "text-yellow-400"
        : "text-bone-50";
  const borderClass =
    tone === "danger"
      ? "border-rose-500/60"
      : tone === "warn"
        ? "border-yellow-400/40"
        : "border-bone-50/20";
  return (
    <div className={`border-2 px-3 py-2 transition-colors ${borderClass}`}>
      <p className="font-mono text-[10.5px] uppercase tracking-widest text-bone-50/50">
        {label}
      </p>
      <p
        className={`mt-0.5 font-display text-[1.31rem] font-bold tabular-nums transition-colors ${valueClass} ${
          pulse ? "animate-pulse" : ""
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function Spinner() {
  return (
    <span
      role="status"
      aria-label="Loading"
      className="inline-block h-[0.92rem] w-[0.92rem] shrink-0 animate-spin rounded-full border-2 border-bone-50/20 border-t-accent"
    />
  );
}

function useDeadlineCountdown(deadline: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadline === null) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [deadline]);
  if (deadline === null) return null;
  return Math.max(0, deadline - now);
}
