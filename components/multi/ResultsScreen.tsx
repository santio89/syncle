"use client";

/**
 * End-of-match standings + post-game choice flow.
 *
 *   - Everyone sees the same sorted leaderboard.
 *   - Each player picks "keep playing" (back to lobby) or "leave" (back to
 *     the main menu) — choices are broadcast so others can see who's in.
 *   - The host can manually trigger "back to lobby" once they're satisfied;
 *     anyone who picked "leave" is evicted on that transition.
 */

import { useRouter } from "next/navigation";
import { useEffect, useMemo } from "react";

import { ArrowIcon } from "@/components/icons/ArrowIcon";
import type { ResultsPayload, RoomActions } from "@/hooks/useRoomSocket";
import type { RoomSnapshot, Standing } from "@/lib/multi/protocol";

export function ResultsScreen({
  snapshot,
  results,
  me,
  isHost,
  actions,
}: {
  snapshot: RoomSnapshot;
  results: ResultsPayload | null;
  me: string;
  isHost: boolean;
  actions: RoomActions;
}) {
  const router = useRouter();

  // Build standings from the snapshot if the server-emitted payload hasn't
  // arrived yet (refresh into the results phase, etc).
  const standings: Standing[] = useMemo(() => {
    if (results?.standings?.length) return results.standings;
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

  const winnerId =
    results?.winnerId ?? (standings[0]?.id ?? snapshot.hostId);
  const winner = standings.find((s) => s.id === winnerId);

  const myChoice =
    snapshot.players.find((p) => p.id === me)?.postChoice ?? null;
  const stayCount = snapshot.players.filter(
    (p) => p.online && p.postChoice === "stay",
  ).length;
  const onlineCount = snapshot.players.filter((p) => p.online).length;

  const handleStay = () => actions.sendChoice("stay");
  const handleLeave = () => {
    actions.sendChoice("leave");
    actions.leave();
    router.push("/");
  };
  const handleHostLobby = () => actions.returnToLobby();

  // ESC = leave shortcut.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Escape") {
        e.preventDefault();
        handleLeave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
      {/* Winner / your spot */}
      <div className="brut-card-accent p-5 sm:p-7">
        <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-accent">
          ░ Match complete
        </p>
        <h2 className="mt-2 font-display text-3xl font-bold leading-none sm:text-4xl">
          {winner ? `${winner.name} wins.` : "No one finished."}
        </h2>
        {winner && (
          <p className="mt-2 font-mono text-sm text-bone-50/80">
            {winner.score.toLocaleString()} ·{" "}
            {winner.accuracy.toFixed(1)}% · ×{winner.maxCombo}
          </p>
        )}

        {standings.length > 0 && (
          <div className="mt-5 border-2 border-bone-50/20 px-3 py-2">
            <p className="font-mono text-[10px] uppercase tracking-widest text-bone-50/50">
              Your run
            </p>
            <YourRunRow me={me} standings={standings} />
          </div>
        )}

        <div className="mt-5 flex flex-col gap-2">
          <button
            onClick={handleStay}
            disabled={myChoice === "stay"}
            className="brut-btn-accent px-4 py-3 disabled:opacity-60"
          >
            {myChoice === "stay" ? "✓ Staying for next round" : "↻ Keep playing"}
          </button>
          <button
            onClick={handleLeave}
            className="brut-btn group inline-flex items-center justify-center gap-2 px-4 py-3"
          >
            <ArrowIcon
              direction="left"
              size={13}
              strokeWidth={2.75}
              className="transition-transform duration-200 group-hover:-translate-x-0.5"
            />
            <span>Back to main menu</span>
          </button>
        </div>

        {isHost && (
          <button
            onClick={handleHostLobby}
            className="brut-btn-accent mt-3 w-full px-4 py-3"
            title="Pull everyone (who chose to stay) back to the lobby for the next round"
          >
            ▶ Host: back to lobby ({stayCount}/{onlineCount} ready)
          </button>
        )}

        <p className="mt-3 text-center font-mono text-[10px] uppercase tracking-widest text-bone-50/40">
          ESC = leave · host kicks off the next round
        </p>
      </div>

      {/* Full leaderboard */}
      <div className="brut-card p-5 sm:p-6">
        <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-accent">
          ░ Final standings
        </p>
        <ol className="mt-3 space-y-1.5">
          {standings.map((s) => {
            const player = snapshot.players.find((p) => p.id === s.id);
            const choice = player?.postChoice ?? null;
            return (
              <li
                key={s.id}
                className={`grid grid-cols-[28px_minmax(0,1fr)_auto_auto] items-baseline gap-2 border-2 px-3 py-2 font-mono text-xs transition-colors ${
                  s.id === me
                    ? "border-accent bg-accent/10"
                    : s.rank === 1
                      ? "border-accent/60"
                      : "border-bone-50/15"
                }`}
              >
                <span
                  className={`text-[11px] uppercase tracking-widest ${
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
                    <span className="ml-1 text-[9px] uppercase text-accent">
                      you
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-right tabular-nums text-bone-50">
                  {s.score.toLocaleString()}
                </span>
                <span className="shrink-0 text-right text-[10px] tracking-widest text-bone-50/55">
                  {choice === "stay"
                    ? "stay"
                    : choice === "leave"
                      ? "left"
                      : s.online
                        ? "—"
                        : "off"}
                </span>
              </li>
            );
          })}
        </ol>
        <p className="mt-3 border-t-2 border-bone-50/10 pt-2 font-mono text-[9px] uppercase tracking-widest text-bone-50/40">
          Stats are saved locally. Cloud sync arrives later.
        </p>
      </div>
    </div>
  );
}

function YourRunRow({
  me,
  standings,
}: {
  me: string;
  standings: Standing[];
}) {
  const mine = standings.find((s) => s.id === me);
  if (!mine) {
    return (
      <p className="mt-1 font-mono text-sm text-bone-50/40">
        no run recorded
      </p>
    );
  }
  return (
    <p className="mt-1 font-mono text-sm text-bone-50">
      <span className="text-accent">#{mine.rank}</span> ·{" "}
      <span className="font-bold">{mine.score.toLocaleString()}</span> ·{" "}
      {mine.accuracy.toFixed(1)}% · ×{mine.maxCombo}
    </p>
  );
}
