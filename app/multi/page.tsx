"use client";

/**
 * Multiplayer entry: pick a name, then either create a new room or join one
 * by code. After the action succeeds we navigate to /multi/<code>.
 *
 * No socket connection is established here directly — `useRoomSocket(null)`
 * opens the connection and we drive the create/join handshake through it.
 * Once we get the room code back from the server, router.push hands off to
 * the room page which re-uses the existing sessionStorage entry to rejoin
 * cleanly under the new URL.
 */

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { GradientBg } from "@/components/GradientBg";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ArrowIcon } from "@/components/icons/ArrowIcon";
import { useRoomSocket } from "@/hooks/useRoomSocket";
import { ROOM_CODE_LENGTH, isValidRoomCode } from "@/lib/multi/protocol";

const NAME_STORAGE_KEY = "syncle.multi.name";

export default function MultiEntryPage() {
  const router = useRouter();
  const { conn, actions } = useRoomSocket(null);

  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"create" | "join" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // After ~3s of staying in "connecting" we surface the cold-start hint.
  // Free Render dynos sleep after 15min idle and take ~30s to wake up.
  const [showColdStartHint, setShowColdStartHint] = useState(false);
  useEffect(() => {
    if (conn === "connected") {
      setShowColdStartHint(false);
      return;
    }
    if (conn !== "connecting" && conn !== "reconnecting") return;
    const t = setTimeout(() => setShowColdStartHint(true), 3_000);
    return () => clearTimeout(t);
  }, [conn]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const stored = window.localStorage.getItem(NAME_STORAGE_KEY);
      if (stored) setName(stored);
    } catch {
      /* localStorage may be disabled */
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (name.trim()) window.localStorage.setItem(NAME_STORAGE_KEY, name.trim());
    } catch {
      /* ignore */
    }
  }, [name]);

  const trimmedName = name.trim();
  const cleanCode = code.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, ROOM_CODE_LENGTH);
  const canSubmit = useMemo(
    () => trimmedName.length > 0 && conn === "connected" && !busy,
    [trimmedName, conn, busy],
  );
  const canJoin = canSubmit && isValidRoomCode(cleanCode);

  const handleCreate = async () => {
    if (!canSubmit) return;
    setBusy("create");
    setError(null);
    const res = await actions.create(trimmedName);
    if (!res.ok) {
      setError(res.message);
      setBusy(null);
      return;
    }
    router.push(`/multi/${res.code}`);
  };

  const handleJoin = async () => {
    if (!canJoin) return;
    setBusy("join");
    setError(null);
    const res = await actions.join(cleanCode, trimmedName);
    if (!res.ok) {
      setError(res.message);
      setBusy(null);
      return;
    }
    router.push(`/multi/${cleanCode}`);
  };

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

        <ConnectionPill conn={conn} />

        {showColdStartHint && (
          <div className="brut-card-accent flex gap-3 px-4 py-3 text-[11px] leading-relaxed text-bone-50/80">
            <span
              aria-hidden
              className="mt-[3px] inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-accent border-t-transparent"
            />
            <div className="flex-1 space-y-1">
              <p className="font-mono text-[10px] uppercase tracking-widest text-accent">
                ░ Waking the multiplayer server
              </p>
              <p>
                The realtime server sleeps when idle and takes around{" "}
                <strong className="text-bone-50">30 seconds</strong> to spin
                back up on the first connection. This happens once — every
                player who joins after that connects instantly. Single-player
                isn't affected.
              </p>
            </div>
          </div>
        )}

        <div className="brut-card space-y-4 p-5 sm:p-6">
          <label className="block">
            <span className="font-mono text-[10px] uppercase tracking-widest text-bone-50/60">
              Display name
            </span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value.slice(0, 20))}
              placeholder="player"
              maxLength={20}
              autoComplete="off"
              spellCheck={false}
              className="mt-1 block w-full border-2 border-bone-50/20 bg-transparent px-3 py-2 font-mono text-sm text-bone-50 outline-none focus:border-accent transition-colors"
            />
            <p className="mt-1 font-mono text-[9px] uppercase tracking-widest text-bone-50/40">
              Up to 20 characters, no formatting.
            </p>
          </label>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <button
              onClick={handleCreate}
              disabled={!canSubmit}
              className="brut-btn-accent flex items-center justify-center gap-2 px-4 py-3 disabled:opacity-50"
            >
              {busy === "create"
                ? "Creating…"
                : conn !== "connected"
                  ? "Waking server…"
                  : "+ Create room"}
            </button>

            <div className="flex flex-col gap-2">
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="ROOM CODE"
                inputMode="text"
                maxLength={ROOM_CODE_LENGTH}
                autoComplete="off"
                spellCheck={false}
                className="border-2 border-bone-50/20 bg-transparent px-3 py-2 text-center font-mono uppercase tracking-[0.4em] text-bone-50 outline-none focus:border-accent transition-colors"
              />
              <button
                onClick={handleJoin}
                disabled={!canJoin}
                className="brut-btn group inline-flex items-center justify-center gap-2 px-4 py-3 disabled:opacity-50"
              >
                {busy === "join" ? (
                  <span>Joining…</span>
                ) : conn !== "connected" ? (
                  <span>Waking server…</span>
                ) : (
                  <>
                    <span>Join</span>
                    <ArrowIcon
                      direction="right"
                      size={14}
                      strokeWidth={2.75}
                      className="transition-transform duration-200 group-hover:translate-x-0.5"
                    />
                  </>
                )}
              </button>
            </div>
          </div>

          {error && (
            <div className="border-2 border-rose-500 p-2 font-mono text-xs text-rose-400">
              {error}
            </div>
          )}
        </div>

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

function ConnectionPill({ conn }: { conn: string }) {
  const label = conn === "connecting"
    ? "Connecting to multiplayer server…"
    : conn === "connected"
      ? "Connected"
      : conn === "reconnecting"
        ? "Reconnecting…"
        : conn === "disconnected"
          ? "Disconnected"
          : "Idle";
  const color =
    conn === "connected"
      ? "border-accent text-accent"
      : conn === "reconnecting" || conn === "connecting"
        ? "border-yellow-400/70 text-yellow-400/90"
        : "border-rose-500 text-rose-400";
  return (
    <p
      className={`inline-flex w-fit items-center gap-2 border-2 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest ${color}`}
    >
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full ${
          conn === "connected" ? "bg-accent" : conn === "disconnected" ? "bg-rose-400" : "bg-yellow-400 animate-pulse"
        }`}
      />
      {label}
    </p>
  );
}
