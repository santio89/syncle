"use client";

/**
 * End-of-match standings + post-game flow.
 *
 *   - Everyone sees the same sorted leaderboard.
 *   - Two big buttons: [Back to room] and [Back to main menu].
 *     - "Back to room": any player who clicks it triggers a server-side
 *       transition that pulls the WHOLE room back to the lobby. No host
 *       confirmation needed (per the new UX brief — "everyone has to go
 *       to the room anyway"). The clicker briefly shows a "Going back…"
 *       state until the snapshot phase flips to "lobby".
 *     - "Back to main menu": this player only — leaves the room and
 *       routes home. Other players keep playing / chatting.
 *   - Live chat sticks around so the room can talk over the standings.
 */

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ArrowIcon } from "@/components/icons/ArrowIcon";
import { useAttemptLeave } from "@/components/LeaveGuardProvider";
import type { ResultsPayload, RoomActions } from "@/hooks/useRoomSocket";
import type { ChatMessage, RoomSnapshot, Standing } from "@/lib/multi/protocol";

import { ChatPanel } from "./ChatPanel";

export function ResultsScreen({
  snapshot,
  results,
  chat,
  me,
  actions,
}: {
  snapshot: RoomSnapshot;
  results: ResultsPayload | null;
  chat: ChatMessage[];
  me: string;
  actions: RoomActions;
}) {
  const router = useRouter();
  const attemptLeave = useAttemptLeave();
  // While we're waiting for the server to flip the room phase back to
  // "lobby" after a "Back to room" click, swap the button to a
  // confirmation pill. We don't unmount this whole screen because the
  // RoomBody phase shell will animate the swap in/out cleanly once
  // the snapshot arrives.
  const [returning, setReturning] = useState(false);

  const standings: Standing[] = useMemo(() => {
    if (results?.standings?.length) return results.standings;
    // Fallback: derive standings from the live snapshot if the
    // `phase:results` event was missed (late socket reconnect, slow
    // network). Includes ALL roster players — late joiners who arrive
    // mid-song or right at results land here too, with whatever live
    // stats they accumulated (zero if they never played a note). They
    // appear at the bottom of the leaderboard, which is the intended
    // UX: the room sees who's present, late joiners can see what
    // happened.
    return [...snapshot.players]
      .map((p) => ({
        id: p.id,
        name: p.name,
        score: p.final?.score ?? p.live.score,
        accuracy: p.final?.accuracy ?? p.live.accuracy,
        maxCombo: p.final?.maxCombo ?? p.live.maxCombo,
        rank: 0,
        online: p.online,
      }))
      .sort((a, b) => b.score - a.score)
      .map((s, i) => ({ ...s, rank: i + 1 }));
  }, [results, snapshot.players]);

  const winnerId = results?.winnerId ?? (standings[0]?.id ?? snapshot.hostId);
  const winner = standings.find((s) => s.id === winnerId);
  const meRow = standings.find((s) => s.id === me);

  const handleBackToRoom = useCallback(() => {
    if (returning) return;
    setReturning(true);
    actions.returnToLobby();
  }, [returning, actions]);

  const handleLeave = useCallback(() => {
    // Routed through the global leave-guard so a results-screen
    // exit also gets the "Are you sure?" prompt — same surface as
    // closing the tab or hitting browser back. Pass-through when
    // the guard happens to be off (shouldn't on results, but the
    // helper handles it gracefully either way).
    attemptLeave(() => {
      actions.sendChoice("leave");
      actions.leave();
      // router.replace so the LeaveGuardProvider can collapse the
      // /multi/[code] entry (and its sentinel) out of history. With
      // router.push the room URL would still sit one back-press
      // behind /; pressing back would re-mount it in the join-form
      // fallback for a player who already left, creating a loop.
      router.replace("/");
    });
  }, [attemptLeave, actions, router]);

  // ESC = leave shortcut. Keep the same affordance as before — quick
  // way out for users who don't want to wait on whatever the room is
  // doing. Use a stable handler to avoid re-binding on every render.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Escape") {
        e.preventDefault();
        handleLeave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleLeave]);

  const me_p = snapshot.players.find((p) => p.id === me);

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
      {/* Left column: hero summary + actions + chat. The chat sits
          under the hero so people can talk over the standings without
          jumping screens. */}
      <div className="flex flex-col gap-4">
        <div className="brut-card-accent p-5 sm:p-7">
          <p className="font-mono text-[10.5px] uppercase tracking-[0.4em] text-accent">
            ░ Match complete
          </p>
          <h2
            className="mt-2 break-words font-display text-[1.97rem] font-bold leading-none sm:text-[2.36rem]"
            data-tooltip={winner ? winner.name : undefined}
          >
            {winner ? `${winner.name} wins.` : "No one finished."}
          </h2>
          {winner && (
            <p className="mt-2 font-mono text-[0.92rem] text-bone-50/80">
              {winner.score.toLocaleString()} ·{" "}
              {winner.accuracy.toFixed(1)}% · ×{winner.maxCombo}
            </p>
          )}

          {meRow && (
            <div className="mt-5 border-2 border-bone-50/20 px-3 py-2">
              <p className="font-mono text-[10.5px] uppercase tracking-widest text-bone-50/50">
                Your run
              </p>
              <p className="mt-1 font-mono text-[0.92rem] text-bone-50">
                <span className="text-accent">#{meRow.rank}</span> ·{" "}
                <span className="font-bold">
                  {meRow.score.toLocaleString()}
                </span>{" "}
                · {meRow.accuracy.toFixed(1)}% · ×{meRow.maxCombo}
              </p>
            </div>
          )}

          <div className="mt-5 flex flex-col gap-2">
            <button
              onClick={handleBackToRoom}
              disabled={returning}
              className="brut-btn-accent group flex items-center justify-center gap-2 px-4 py-3 disabled:opacity-70"
              data-tooltip={
                returning
                  ? "Waiting on the server to flip the phase…"
                  : "Pull everyone back to the lobby"
              }
            >
              {returning ? (
                <>
                  <span
                    aria-hidden
                    className="inline-block h-[0.86rem] w-[0.86rem] shrink-0 animate-spin rounded-full border-2 border-ink-900/30 border-t-ink-900"
                  />
                  <span>Going back to the room…</span>
                </>
              ) : (
                <>
                  <span>Back to room</span>
                  <span
                    aria-hidden
                    className="inline-block transition-transform duration-200 group-hover:translate-x-0.5"
                  >
                    ↻
                  </span>
                </>
              )}
            </button>
            <button
              onClick={handleLeave}
              className="brut-btn group inline-flex items-center justify-center gap-2 px-4 py-3"
            >
              <ArrowIcon
                direction="left"
                size={14}
                strokeWidth={2.75}
                className="transition-transform duration-200 group-hover:-translate-x-0.5"
              />
              <span>Back to main menu</span>
            </button>
          </div>

          <p className="mt-3 text-center font-mono text-[10.5px] uppercase tracking-widest text-bone-50/40">
            ESC = leave to main menu
          </p>
        </div>

        <div className="min-h-[18rem]">
          <ChatPanel
            chat={chat}
            meId={me}
            meIsMuted={!!me_p?.muted}
            onSend={actions.sendChat}
          />
        </div>
      </div>

      {/* Right column: full leaderboard. */}
      <div className="brut-card p-5 sm:p-6">
        <p className="font-mono text-[10.5px] uppercase tracking-[0.4em] text-accent">
          ░ Final standings
        </p>
        <ol className="mt-3 space-y-1.5">
          {standings.map((s) => (
            <li
              key={s.id}
              className={`grid grid-cols-[28px_minmax(0,1fr)_auto] items-baseline gap-2 border-2 px-3 py-2 font-mono text-[0.79rem] transition-colors ${
                s.id === me
                  ? "border-accent bg-accent/10"
                  : s.rank === 1
                    ? "border-accent/60"
                    : "border-bone-50/15"
              }`}
            >
              <span
                className={`text-[11.5px] uppercase tracking-widest ${
                  s.rank === 1
                    ? "text-accent"
                    : s.rank === 2
                      ? "text-bone-50/85"
                      : s.rank === 3
                        ? "text-bone-50/65"
                        : "text-bone-50/40"
                }`}
              >
                #{s.rank}
              </span>
              <span className="min-w-0 truncate text-bone-50">
                {s.name}
                {s.id === me && (
                  <span className="ml-1 text-[9.5px] uppercase text-accent">
                    you
                  </span>
                )}
              </span>
              <span className="shrink-0 text-right tabular-nums text-bone-50">
                {s.score.toLocaleString()}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
