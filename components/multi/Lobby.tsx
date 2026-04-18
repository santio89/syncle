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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ArrowIcon } from "@/components/icons/ArrowIcon";
import type { RoomActions } from "@/hooks/useRoomSocket";
import type { ChartMode, ModeAvailability } from "@/lib/game/chart";
import {
  displayMode,
  MODE_ORDER,
  modeStars,
  probeSongModes,
} from "@/lib/game/chart";
import type {
  CatalogItem,
  RoomSnapshot,
  SongRef,
} from "@/lib/multi/protocol";
import { MAX_PLAYERS_PER_ROOM, NAME_MAX_LEN } from "@/lib/multi/protocol";

const MODES_TOP: ChartMode[] = ["easy", "normal", "hard"];
const MODES_BOTTOM: ChartMode[] = ["insane", "expert"];

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
        <p className="font-mono text-[10.5px] uppercase tracking-[0.4em] text-accent">
          ░ Players
        </p>
        <span className="font-mono text-[10.5px] uppercase tracking-widest text-bone-50/50">
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
            <span className="flex-1 truncate font-mono text-[0.92rem] text-bone-50/90">
              {p.name || "—"}
            </span>
            {p.isHost && (
              <span
                className="font-mono text-[9.5px] uppercase tracking-widest text-accent"
                title="Room host"
              >
                ★ host
              </span>
            )}
          </li>
        ))}
      </ul>

      {/* Rename action sits under the player list. The "Your name"
          caption used to live here but it was redundant — the
          player's own row in the list above already says "you" next
          to their name, and the "rename" verb is self-evident. The
          top border keeps the visual break between "who's in the
          room" and "your own controls". */}
      <div className="mt-4 border-t-2 border-bone-50/10 pt-3">
        {editing ? (
          <div className="flex gap-2">
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value.slice(0, NAME_MAX_LEN))}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
                if (e.key === "Escape") setEditing(false);
              }}
              maxLength={NAME_MAX_LEN}
              className="flex-1 border-2 border-bone-50/20 bg-transparent px-2 py-1 font-mono text-[0.92rem] text-bone-50 outline-none focus:border-accent"
            />
            <button
              onClick={commit}
              className="brut-btn-accent px-3 py-1 text-[0.79rem]"
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
            className="inline-flex items-center gap-2 font-mono text-[0.79rem] uppercase tracking-widest text-bone-50/70 hover:text-accent"
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

  // Per-song probe: which difficulties does the currently-selected song
  // actually have? `null` = unknown (probe in flight or not yet started),
  // ModeAvailability = probe done, error = probe failed.
  const [modeProbe, setModeProbe] = useState<ModeAvailability | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);
  // Guard against late results from a previous selection clobbering newer
  // state when the host clicks through several songs quickly.
  const probeReqId = useRef(0);

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

  // Probe mode availability whenever the selected song changes. The probe
  // also warms the per-set cache used by `loadSongById`, so the host's
  // eventual "Start match" loads instantly with no extra download.
  useEffect(() => {
    if (!selected) {
      setModeProbe(null);
      setProbeError(null);
      setProbing(false);
      return;
    }
    const reqId = ++probeReqId.current;
    setModeProbe(null);
    setProbeError(null);
    setProbing(true);
    probeSongModes(selected.beatmapsetId)
      .then((modes) => {
        if (probeReqId.current !== reqId) return;
        setModeProbe(modes);
        setProbing(false);
        // Auto-correct: if the host had picked a mode that this song doesn't
        // expose, snap to the first mode that IS available so "Start match"
        // never sends an impossible difficulty to clients.
        setMode((current) => (modes.available[current] ? current : firstAvailableMode(modes)));
      })
      .catch((err) => {
        if (probeReqId.current !== reqId) return;
        setProbing(false);
        setProbeError(err?.message ?? "Couldn't read difficulty list");
      });
  }, [selected]);

  // Don't let the host start a match with a difficulty the song doesn't have.
  const modeReady = !!modeProbe?.available[mode];
  const canStart =
    !!selected &&
    !starting &&
    !probing &&
    modeReady &&
    snapshot.players.some((p) => p.online);

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
          <p className="font-mono text-[10.5px] uppercase tracking-[0.4em] text-accent">
            ░ Host controls
          </p>
          <h3 className="mt-1 font-display text-[1.31rem] font-bold">
            Pick the song.
          </h3>
        </div>
        <button
          onClick={copyCode}
          className="brut-btn px-3 py-2 text-[0.79rem]"
          title="Copy room code"
        >
          ⧉ copy code
        </button>
      </div>

      {/* Selected preview */}
      <div className="mt-4 border-2 border-bone-50/20 px-3 py-2">
        <div className="flex items-center justify-between gap-3">
          <p className="font-mono text-[10.5px] uppercase tracking-widest text-bone-50/50">
            Selected
          </p>
          {selected && (
            <p className="font-mono text-[9.5px] uppercase tracking-widest text-bone-50/45">
              {probing
                ? "checking difficulties…"
                : modeProbe
                  ? availableModesLabel(modeProbe)
                  : probeError
                    ? "probe failed"
                    : ""}
            </p>
          )}
        </div>
        {selected ? (
          <p
            className="mt-0.5 truncate font-mono text-[0.92rem] text-bone-50/90"
            title={`${selected.artist} — ${selected.title}`}
          >
            <span className="text-bone-50/60">{selected.artist}</span> —{" "}
            <span className="text-bone-50">{selected.title}</span>
          </p>
        ) : (
          <p className="mt-0.5 font-mono text-[0.92rem] text-bone-50/40">
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
          className="flex-1 border-2 border-bone-50/20 bg-transparent px-3 py-2 font-mono text-[0.79rem] text-bone-50 outline-none focus:border-accent"
        />
        <button
          onClick={() => fetchCatalog(true)}
          disabled={loading}
          className="brut-btn px-3 py-2 text-[0.79rem] disabled:opacity-50"
          title="Refresh the candidate pool"
        >
          {loading ? "…" : "↻"}
        </button>
      </div>

      <div className="mt-2 max-h-72 min-h-[10rem] flex-1 overflow-y-auto border-2 border-bone-50/10">
        {error && (
          <p className="border-b-2 border-rose-500 p-3 font-mono text-[0.79rem] text-rose-400">
            {error}
          </p>
        )}
        {loading && !catalog && (
          <p className="p-3 font-mono text-[0.79rem] text-bone-50/50">
            Fetching osu!mania 4K candidates…
          </p>
        )}
        {!loading && filtered.length === 0 && (
          <p className="p-3 font-mono text-[0.79rem] text-bone-50/40">
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
                  className={`flex w-full items-baseline justify-between gap-2 border-b border-bone-50/5 px-3 py-2 text-left font-mono text-[0.79rem] transition-colors hover:bg-bone-50/5 ${
                    active ? "bg-accent/15 text-bone-50" : "text-bone-50/80"
                  }`}
                >
                  <span className="min-w-0 truncate">
                    <span className="text-bone-50/55">{c.artist}</span>{" "}
                    <span className="text-bone-50">— {c.title}</span>
                  </span>
                  <span className="shrink-0 font-mono text-[9.5px] uppercase tracking-widest text-bone-50/30">
                    {c.source}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {/* Difficulty + start. Picker is a 3+2 grid mirroring the Syncle
          tier ladder; insane/expert sit on the bottom row to read as
          "extras" you only see lit up when the mapper shipped them.

          Availability rules:
            - no song picked yet  → every tier appears enabled (it's just
              the host's local default before a song is in play)
            - song picked, probe pending → every tier disabled (cursor:
              wait) so the host doesn't accidentally start a round before
              we know what the .osz actually offers
            - probe resolved      → only tiers the song ships are clickable */}
      <div className="mt-4 space-y-1">
        <div className="grid grid-cols-3 gap-1">
          {MODES_TOP.map((m) => (
            <HostModeButton
              key={m}
              mode={m}
              selected={mode === m}
              probe={modeProbe}
              probing={probing}
              hasSelectedSong={!!selected}
              onPick={setMode}
            />
          ))}
        </div>
        <div className="grid grid-cols-2 gap-1">
          {MODES_BOTTOM.map((m) => (
            <HostModeButton
              key={m}
              mode={m}
              selected={mode === m}
              probe={modeProbe}
              probing={probing}
              hasSelectedSong={!!selected}
              onPick={setMode}
            />
          ))}
        </div>
      </div>

      {probeError && (
        <p className="mt-2 font-mono text-[10.5px] uppercase tracking-widest text-rose-400">
          {probeError}
        </p>
      )}

      <button
        onClick={handleStart}
        disabled={!canStart}
        className="brut-btn-accent group mt-3 flex w-full items-center justify-center gap-2 px-4 py-3 disabled:opacity-50"
      >
        {starting ? (
          <span>Starting…</span>
        ) : probing ? (
          <span>Reading chart…</span>
        ) : selected && !modeReady ? (
          <span>Pick an available difficulty</span>
        ) : (
          <>
            <span>Start match</span>
            {/* Play triangle after the label, with the same slide-on-
                hover treatment as the arrow icons (Back / Join room)
                elsewhere. Only rendered in the "ready to start" state
                — the loading / error states don't get an icon since
                they're not interactive cues. */}
            <span
              aria-hidden
              className="inline-block transition-transform duration-200 group-hover:translate-x-0.5"
            >
              ▶
            </span>
          </>
        )}
      </button>
      <p className="mt-4 text-center font-mono text-[10.5px] uppercase tracking-widest text-bone-50/40">
        Everyone has 30s to download + decode the song
      </p>
    </div>
  );
}

/**
 * Pick the first available mode in difficulty order. At least one tier
 * is always available because finalize() guarantees mapper-shipped
 * charts always count as available; the `"easy"` terminator is purely
 * defensive — if the loop below ever exits we'd be looking at a song
 * with zero parseable charts, which `rawSessionFromExtracted` already
 * rejects upstream.
 */
function firstAvailableMode(modes: ModeAvailability): ChartMode {
  for (const m of MODE_ORDER) {
    if (modes.available[m]) return m;
  }
  return "easy";
}

/**
 * One difficulty button in the host's picker. Centralizes the "is it
 * enabled / styled / what label?" logic so the top and bottom row stay
 * visually consistent and the JSX up in HostPane reads like a layout,
 * not a state machine.
 */
function HostModeButton({
  mode,
  selected,
  probe,
  probing,
  hasSelectedSong,
  onPick,
}: {
  mode: ChartMode;
  selected: boolean;
  probe: ModeAvailability | null;
  probing: boolean;
  hasSelectedSong: boolean;
  onPick: (m: ChartMode) => void;
}) {
  // Match single-player ModeButton behavior: every tier is always
  // rendered with its name + 5-star intensity row, just disabled until
  // we know what the song ships. That keeps the picker grid stable
  // (no buttons hiding / collapsing) and reads as "loading the menu"
  // rather than "menu disappeared".
  const available = !hasSelectedSong ? true : !!probe?.available[mode];
  const disabled = hasSelectedSong && (probing || !available);
  const enabled = !disabled;
  const reason = !hasSelectedSong
    ? undefined
    : probing
      ? "Reading the song's difficulty list…"
      : !available
        ? `This song doesn't ship a ${displayMode(mode)} chart.`
        : undefined;
  const stars = modeStars(mode);
  return (
    <button
      onClick={() => enabled && onPick(mode)}
      disabled={disabled}
      title={
        reason ?? `${displayMode(mode).toUpperCase()} · ${stars} / 5 intensity`
      }
      className={`flex flex-col items-center justify-center gap-0.5 font-mono text-[10.5px] uppercase tracking-widest border-2 py-1.5 transition-colors ${
        selected && available
          ? "border-accent bg-accent text-ink-900"
          : disabled
            ? probing
              ? // Probing is transient ("waiting on the song probe");
                // keep the solid outline + cursor-wait so the slot
                // still feels live, just not yet pickable.
                "border-bone-50/30 text-bone-50/50 cursor-wait"
              : // Permanently unavailable (this song doesn't ship the
                // tier and can't synthesize it): dashed outline + much
                // dimmer text. Mirrors the single-player ModeButton so
                // the same visual language tells the player "off, not
                // loading" everywhere a difficulty picker exists.
                "border-dashed border-bone-50/20 text-bone-50/35 cursor-not-allowed"
            : "border-bone-50/30 text-bone-50/60 hover:border-bone-50/60"
      }`}
    >
      <span>{displayMode(mode)}</span>
      {/* Fixed 5-slot star row keeps every button the same width, so
          easy and expert don't visually shift the picker grid. Stars
          fade further on a permanently unavailable tier so they don't
          out-shout the dimmed name. */}
      <span
        aria-hidden
        className={`text-[8.5px] leading-none tracking-[0.2em] ${disabled && !probing ? "opacity-60" : ""}`}
      >
        {"★".repeat(stars)}
        <span className="opacity-30">{"★".repeat(5 - stars)}</span>
      </span>
    </button>
  );
}

function availableModesLabel(modes: ModeAvailability): string {
  const tags: string[] = [];
  for (const m of MODE_ORDER) {
    if (modes.available[m]) tags.push(displayMode(m));
  }
  return tags.length ? `has: ${tags.join(" / ")}` : "no playable diffs";
}

/* ------------------------------------------------------------------------ */
/* Guest pane                                                               */
/* ------------------------------------------------------------------------ */

function GuestPane({ snapshot }: { snapshot: RoomSnapshot }) {
  const selected = snapshot.selectedSong;
  return (
    <div className="brut-card flex h-full flex-col items-start gap-4 p-5 sm:p-6">
      <div>
        <p className="font-mono text-[10.5px] uppercase tracking-[0.4em] text-accent">
          ░ Waiting for host
        </p>
        <h3 className="mt-1 font-display text-[1.31rem] font-bold">
          Sit tight — host is picking.
        </h3>
        <p className="mt-2 max-w-md text-[0.92rem] text-bone-50/65">
          The host of this room chooses the song and difficulty. As soon as
          they hit start you&apos;ll get a 30s window to download it on your
          end.
        </p>
      </div>

      <div className="w-full border-2 border-bone-50/20 px-3 py-2">
        <p className="font-mono text-[10.5px] uppercase tracking-widest text-bone-50/50">
          Currently selected
        </p>
        {selected ? (
          <p
            className="mt-0.5 truncate font-mono text-[0.92rem] text-bone-50/90"
            title={`${selected.artist} — ${selected.title}`}
          >
            <ArrowIcon
              direction="right"
              size={13}
              strokeWidth={2.75}
              className="mr-1 inline align-middle text-accent"
            />
            <span className="text-bone-50/60">{selected.artist}</span> —{" "}
            <span className="text-bone-50">{selected.title}</span>
          </p>
        ) : (
          <p className="mt-0.5 font-mono text-[0.92rem] text-bone-50/40">
            nothing yet
          </p>
        )}
      </div>
    </div>
  );
}
