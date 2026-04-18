"use client";

/**
 * Multiplayer lobby. Two stacked cards:
 *
 *   1. Player roster — everyone in the room with host crown / online dot.
 *      You can rename yourself in place; everyone else's name is read-only.
 *
 *   2. Host pane — only rendered with controls for the host. Picks a song
 *      from the catalog (loaded on demand via `host:catalogRequest`), then
 *      a difficulty, then "Start" kicks the loading phase. Non-hosts see a
 *      "waiting for the host" placeholder with the currently selected song
 *      preview if any.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { ArrowIcon } from "@/components/icons/ArrowIcon";
import type { RoomActions } from "@/hooks/useRoomSocket";
import type { ChartMode } from "@/lib/game/chart";
import type {
  CatalogItem,
  RoomSnapshot,
  SongRef,
} from "@/lib/multi/protocol";
import { MAX_PLAYERS_PER_ROOM, NAME_MAX_LEN } from "@/lib/multi/protocol";

const MODES: ChartMode[] = ["easy", "normal", "hard"];

export function Lobby({
  code,
  snapshot,
  isHost,
  actions,
}: {
  code: string;
  snapshot: RoomSnapshot;
  isHost: boolean;
  actions: RoomActions;
}) {
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_minmax(0,1.2fr)]">
      <PlayerRoster snapshot={snapshot} actions={actions} />
      {isHost ? (
        <HostPane snapshot={snapshot} actions={actions} code={code} />
      ) : (
        <GuestPane snapshot={snapshot} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Roster                                                                   */
/* ------------------------------------------------------------------------ */

function PlayerRoster({
  snapshot,
  actions,
}: {
  snapshot: RoomSnapshot;
  actions: RoomActions;
}) {
  const [editing, setEditing] = useState(false);
  // Find "me" by socket session: we don't have direct access here, but the
  // host pane already knows isHost. Cleanest is to render every player as
  // read-only and let the user rename via the dedicated input below.
  // Players are already sorted by joinedAt on the server.

  const [draft, setDraft] = useState("");

  const commit = useCallback(() => {
    const name = draft.trim();
    if (name) actions.setName(name);
    setEditing(false);
  }, [draft, actions]);

  return (
    <div className="brut-card flex h-full flex-col p-5 sm:p-6">
      <div className="flex items-baseline justify-between gap-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-accent">
          ░ Players
        </p>
        <span className="font-mono text-[10px] uppercase tracking-widest text-bone-50/50">
          {snapshot.players.length} / {MAX_PLAYERS_PER_ROOM}
        </span>
      </div>

      <ul className="mt-3 flex-1 space-y-1.5">
        {snapshot.players.map((p) => (
          <li
            key={p.id}
            className="flex items-center gap-2 border-2 border-bone-50/10 px-3 py-2"
          >
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                p.online ? "bg-accent" : "bg-bone-50/30"
              }`}
              title={p.online ? "Online" : "Disconnected"}
            />
            <span className="flex-1 truncate font-mono text-sm text-bone-50/90">
              {p.name || "—"}
            </span>
            {p.isHost && (
              <span
                className="font-mono text-[9px] uppercase tracking-widest text-accent"
                title="Room host"
              >
                ★ host
              </span>
            )}
          </li>
        ))}
      </ul>

      <div className="mt-4 border-t-2 border-bone-50/10 pt-3">
        <p className="font-mono text-[10px] uppercase tracking-widest text-bone-50/50">
          Your name
        </p>
        {editing ? (
          <div className="mt-1 flex gap-2">
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value.slice(0, NAME_MAX_LEN))}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
                if (e.key === "Escape") setEditing(false);
              }}
              maxLength={NAME_MAX_LEN}
              className="flex-1 border-2 border-bone-50/20 bg-transparent px-2 py-1 font-mono text-sm text-bone-50 outline-none focus:border-accent"
            />
            <button
              onClick={commit}
              className="brut-btn-accent px-3 py-1 text-xs"
            >
              save
            </button>
          </div>
        ) : (
          <button
            onClick={() => {
              setDraft("");
              setEditing(true);
            }}
            className="mt-1 inline-flex items-center gap-2 font-mono text-xs uppercase tracking-widest text-bone-50/70 hover:text-accent"
          >
            <span>rename</span>
          </button>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Host pane                                                                */
/* ------------------------------------------------------------------------ */

function HostPane({
  snapshot,
  actions,
  code,
}: {
  snapshot: RoomSnapshot;
  actions: RoomActions;
  code: string;
}) {
  const [catalog, setCatalog] = useState<CatalogItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ChartMode>("easy");
  const [filter, setFilter] = useState("");
  const [starting, setStarting] = useState(false);

  const fetchCatalog = useCallback(
    async (refresh: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const items = await actions.requestCatalog(refresh);
        setCatalog(items);
      } catch (e: any) {
        setError(e?.message ?? "Failed to load catalog");
      } finally {
        setLoading(false);
      }
    },
    [actions],
  );

  useEffect(() => {
    if (catalog === null && !loading) void fetchCatalog(false);
  }, [catalog, loading, fetchCatalog]);

  const filtered = useMemo(() => {
    if (!catalog) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return catalog;
    return catalog.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        c.artist.toLowerCase().includes(q),
    );
  }, [catalog, filter]);

  const selected = snapshot.selectedSong;
  const canStart =
    !!selected && !starting && snapshot.players.some((p) => p.online);

  const handleStart = () => {
    if (!canStart) return;
    setStarting(true);
    actions.startMatch(mode);
    // Server will flip phase, which unmounts this pane.
  };

  const copyCode = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    void navigator.clipboard.writeText(code).catch(() => {});
  }, [code]);

  return (
    <div className="brut-card flex h-full flex-col p-5 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-accent">
            ░ Host controls
          </p>
          <h3 className="mt-1 font-display text-xl font-bold">
            Pick the song.
          </h3>
        </div>
        <button
          onClick={copyCode}
          className="brut-btn px-3 py-2 text-xs"
          title="Copy room code"
        >
          ⧉ copy code
        </button>
      </div>

      {/* Selected preview */}
      <div className="mt-4 border-2 border-bone-50/20 px-3 py-2">
        <p className="font-mono text-[10px] uppercase tracking-widest text-bone-50/50">
          Selected
        </p>
        {selected ? (
          <p
            className="mt-0.5 truncate font-mono text-sm text-bone-50/90"
            title={`${selected.artist} — ${selected.title}`}
          >
            <span className="text-bone-50/60">{selected.artist}</span> —{" "}
            <span className="text-bone-50">{selected.title}</span>
          </p>
        ) : (
          <p className="mt-0.5 font-mono text-sm text-bone-50/40">
            nothing yet — pick from the catalog below
          </p>
        )}
      </div>

      {/* Catalog */}
      <div className="mt-4 flex items-center gap-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter by title or artist…"
          className="flex-1 border-2 border-bone-50/20 bg-transparent px-3 py-2 font-mono text-xs text-bone-50 outline-none focus:border-accent"
        />
        <button
          onClick={() => fetchCatalog(true)}
          disabled={loading}
          className="brut-btn px-3 py-2 text-xs disabled:opacity-50"
          title="Refresh the candidate pool"
        >
          {loading ? "…" : "↻"}
        </button>
      </div>

      <div className="mt-2 max-h-72 min-h-[10rem] flex-1 overflow-y-auto border-2 border-bone-50/10">
        {error && (
          <p className="border-b-2 border-rose-500 p-3 font-mono text-xs text-rose-400">
            {error}
          </p>
        )}
        {loading && !catalog && (
          <p className="p-3 font-mono text-xs text-bone-50/50">
            Fetching osu!mania 4K candidates…
          </p>
        )}
        {!loading && filtered.length === 0 && (
          <p className="p-3 font-mono text-xs text-bone-50/40">
            No tracks match that filter.
          </p>
        )}
        <ul>
          {filtered.map((c) => {
            const active = selected?.beatmapsetId === c.beatmapsetId;
            return (
              <li key={c.beatmapsetId}>
                <button
                  onClick={() => actions.selectSong(c as SongRef)}
                  className={`flex w-full items-baseline justify-between gap-2 border-b border-bone-50/5 px-3 py-2 text-left font-mono text-xs transition-colors hover:bg-bone-50/5 ${
                    active ? "bg-accent/15 text-bone-50" : "text-bone-50/80"
                  }`}
                >
                  <span className="min-w-0 truncate">
                    <span className="text-bone-50/55">{c.artist}</span>{" "}
                    <span className="text-bone-50">— {c.title}</span>
                  </span>
                  <span className="shrink-0 font-mono text-[9px] uppercase tracking-widest text-bone-50/30">
                    {c.source}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {/* Difficulty + start */}
      <div className="mt-4 grid grid-cols-3 gap-1">
        {MODES.map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`font-mono text-[10px] uppercase tracking-widest border-2 py-1.5 transition-colors ${
              mode === m
                ? "border-accent bg-accent text-ink-900"
                : "border-bone-50/30 text-bone-50/60 hover:border-bone-50/60"
            }`}
          >
            {m === "easy" ? "easy ★" : m === "normal" ? "normal ★★" : "hard ★★★"}
          </button>
        ))}
      </div>

      <button
        onClick={handleStart}
        disabled={!canStart}
        className="brut-btn-accent mt-3 w-full px-4 py-3 disabled:opacity-50"
      >
        {starting ? "Starting…" : "▶ Start match"}
      </button>
      <p className="mt-2 text-center font-mono text-[10px] uppercase tracking-widest text-bone-50/40">
        Everyone has 30s to download + decode the song
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Guest pane                                                               */
/* ------------------------------------------------------------------------ */

function GuestPane({ snapshot }: { snapshot: RoomSnapshot }) {
  const selected = snapshot.selectedSong;
  return (
    <div className="brut-card flex h-full flex-col items-start gap-4 p-5 sm:p-6">
      <div>
        <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-accent">
          ░ Waiting for host
        </p>
        <h3 className="mt-1 font-display text-xl font-bold">
          Sit tight — host is picking.
        </h3>
        <p className="mt-2 max-w-md text-sm text-bone-50/65">
          The host of this room chooses the song and difficulty. As soon as
          they hit start you&apos;ll get a 30s window to download it on your
          end.
        </p>
      </div>

      <div className="w-full border-2 border-bone-50/20 px-3 py-2">
        <p className="font-mono text-[10px] uppercase tracking-widest text-bone-50/50">
          Currently selected
        </p>
        {selected ? (
          <p
            className="mt-0.5 truncate font-mono text-sm text-bone-50/90"
            title={`${selected.artist} — ${selected.title}`}
          >
            <ArrowIcon
              direction="right"
              size={12}
              strokeWidth={2.75}
              className="mr-1 inline align-middle text-accent"
            />
            <span className="text-bone-50/60">{selected.artist}</span> —{" "}
            <span className="text-bone-50">{selected.title}</span>
          </p>
        ) : (
          <p className="mt-0.5 font-mono text-sm text-bone-50/40">
            nothing yet
          </p>
        )}
      </div>
    </div>
  );
}
