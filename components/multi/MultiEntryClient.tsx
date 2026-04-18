"use client";

/**
 * Socket-using portion of the /multi entry page. Code-split via next/dynamic
 * so the parent page (header + intro copy + "How it works" steps) can render
 * instantly without waiting on the ~50 KB socket.io-client bundle and its
 * transitive deps to come down. The skeleton in `MultiEntryFallback` keeps
 * layout stable during that brief swap.
 *
 * Three sub-flows live behind a tab switcher:
 *
 *   Create  → name + (optional) room name + public/private toggle
 *   Join    → 6-char room code
 *   Browse  → live list of public rooms (refreshable; empty state when none)
 *
 * The display name input is shared across tabs since "you need a name" is
 * a universal precondition. Any error from create/join is shown inline.
 *
 * If we landed here because we got kicked (server set
 * `sessionStorage["syncle.kicked.notice"]` before redirecting), surface
 * a one-shot dismissable banner explaining what happened.
 */

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ArrowIcon } from "@/components/icons/ArrowIcon";
import { useRoomSocket } from "@/hooks/useRoomSocket";
import {
  ROOM_CODE_LENGTH,
  ROOM_NAME_MAX_LEN,
  type PublicRoomEntry,
  isValidRoomCode,
} from "@/lib/multi/protocol";

const NAME_STORAGE_KEY = "syncle.multi.name";
const ROOM_NAME_STORAGE_KEY = "syncle.multi.roomName";
const VISIBILITY_STORAGE_KEY = "syncle.multi.visibility";
const KICK_NOTICE_KEY = "syncle.kicked.notice";

type Tab = "create" | "join" | "browse";

export default function MultiEntryClient() {
  const router = useRouter();
  const { conn, actions } = useRoomSocket(null);

  const [tab, setTab] = useState<Tab>("create");
  const [name, setName] = useState("");
  const [roomName, setRoomName] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">("private");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"create" | "join" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // After ~3s of staying in "connecting" we surface the cold-start hint.
  // Free Render dynos sleep after 15min idle and take ~30s to wake up.
  const [showColdStartHint, setShowColdStartHint] = useState(false);
  const [kickNotice, setKickNotice] = useState<string | null>(null);

  /* ---------------- restore state from previous visit ---------------- */
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const storedName = window.localStorage.getItem(NAME_STORAGE_KEY);
      if (storedName) setName(storedName);
      const storedRoom = window.localStorage.getItem(ROOM_NAME_STORAGE_KEY);
      if (storedRoom) setRoomName(storedRoom);
      const storedVis = window.localStorage.getItem(VISIBILITY_STORAGE_KEY);
      if (storedVis === "public" || storedVis === "private") {
        setVisibility(storedVis);
      }
    } catch {
      /* ignore */
    }
    try {
      const notice = window.sessionStorage.getItem(KICK_NOTICE_KEY);
      if (notice) {
        setKickNotice(notice);
        window.sessionStorage.removeItem(KICK_NOTICE_KEY);
      }
    } catch {
      /* ignore */
    }
  }, []);

  /* ---------------- persist state ---------------- */
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (name.trim())
        window.localStorage.setItem(NAME_STORAGE_KEY, name.trim());
    } catch {
      /* ignore */
    }
  }, [name]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(ROOM_NAME_STORAGE_KEY, roomName.trim());
    } catch {
      /* ignore */
    }
  }, [roomName]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(VISIBILITY_STORAGE_KEY, visibility);
    } catch {
      /* ignore */
    }
  }, [visibility]);

  useEffect(() => {
    if (conn === "connected") {
      setShowColdStartHint(false);
      return;
    }
    if (conn !== "connecting" && conn !== "reconnecting") return;
    const t = setTimeout(() => setShowColdStartHint(true), 3_000);
    return () => clearTimeout(t);
  }, [conn]);

  const trimmedName = name.trim();
  const trimmedRoom = roomName.trim();
  const cleanCode = code
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, ROOM_CODE_LENGTH);
  const canSubmit = useMemo(
    () => trimmedName.length > 0 && conn === "connected" && !busy,
    [trimmedName, conn, busy],
  );
  const canJoin = canSubmit && isValidRoomCode(cleanCode);

  const handleCreate = async () => {
    if (!canSubmit) return;
    setBusy("create");
    setError(null);
    const res = await actions.create(trimmedName, {
      name: trimmedRoom || undefined,
      visibility,
    });
    if (!res.ok) {
      setError(res.message);
      setBusy(null);
      return;
    }
    router.push(`/multi/${res.code}`);
  };

  const handleJoin = useCallback(
    async (overrideCode?: string) => {
      const target = (overrideCode ?? cleanCode).toUpperCase();
      if (!isValidRoomCode(target) || !trimmedName || conn !== "connected") {
        return;
      }
      setBusy("join");
      setError(null);
      const res = await actions.join(target, trimmedName);
      if (!res.ok) {
        setError(res.message);
        setBusy(null);
        return;
      }
      router.push(`/multi/${target}`);
    },
    [actions, cleanCode, trimmedName, conn, router],
  );

  return (
    <>
      <ConnectionPill conn={conn} />

      {kickNotice && (
        <div
          className="brut-card-accent flex items-start justify-between gap-3 px-4 py-3 text-[11.5px] leading-relaxed text-bone-50/85"
          role="alert"
        >
          <div className="flex-1">
            <p className="font-mono text-[10.5px] uppercase tracking-widest text-rose-400">
              ░ Removed from room
            </p>
            <p className="mt-1">{kickNotice}</p>
          </div>
          <button
            onClick={() => setKickNotice(null)}
            className="font-mono text-[10.5px] uppercase tracking-widest text-bone-50/60 hover:text-accent transition-colors"
          >
            dismiss
          </button>
        </div>
      )}

      {showColdStartHint && (
        <div className="brut-card-accent flex gap-3 px-4 py-3 text-[11.5px] leading-relaxed text-bone-50/80">
          <span
            aria-hidden
            className="mt-[3px] inline-block h-[0.79rem] w-[0.79rem] shrink-0 animate-spin rounded-full border-2 border-accent border-t-transparent"
          />
          <div className="flex-1 space-y-1">
            <p className="font-mono text-[10.5px] uppercase tracking-widest text-accent">
              ░ Waking the multiplayer server
            </p>
            <p>
              The realtime server sleeps when idle and takes around{" "}
              <strong className="text-bone-50">30 seconds</strong> to spin
              back up on the first connection. This happens once — every
              player who joins after that connects instantly. Single-player
              isn&apos;t affected.
            </p>
          </div>
        </div>
      )}

      <div className="brut-card space-y-5 p-5 sm:p-6">
        {/* Display name lives outside the tabs because every action
            requires a name. Putting it once at the top means switching
            tabs feels weightless. */}
        <label className="block">
          <span className="font-mono text-[10.5px] uppercase tracking-widest text-bone-50/60">
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
            className="mt-1 block w-full border-2 border-bone-50/20 bg-transparent px-3 py-2 font-mono text-[0.92rem] text-bone-50 outline-none focus:border-accent transition-colors"
          />
          <p className="mt-1 font-mono text-[9.5px] uppercase tracking-widest text-bone-50/40">
            Up to 20 characters, no formatting.
          </p>
        </label>

        <TabBar tab={tab} onChange={setTab} />

        {tab === "create" && (
          <CreatePane
            roomName={roomName}
            onRoomName={setRoomName}
            visibility={visibility}
            onVisibility={setVisibility}
            onSubmit={handleCreate}
            busy={busy === "create"}
            disabled={!canSubmit}
            conn={conn}
          />
        )}
        {tab === "join" && (
          <JoinPane
            code={code}
            onCode={setCode}
            cleanCode={cleanCode}
            onSubmit={() => handleJoin()}
            busy={busy === "join"}
            disabled={!canJoin}
            conn={conn}
          />
        )}
        {tab === "browse" && (
          <BrowsePane
            actions={actions}
            conn={conn}
            onJoin={(c) => handleJoin(c)}
            disabled={!trimmedName || conn !== "connected" || busy !== null}
            disabledReason={
              !trimmedName
                ? "Enter a display name first"
                : conn !== "connected"
                  ? "Waiting for the server…"
                  : null
            }
          />
        )}

        {error && (
          <div className="border-2 border-rose-500 p-2 font-mono text-[0.79rem] text-rose-400">
            {error}
          </div>
        )}
      </div>
    </>
  );
}

/* ---------------------------------------------------------------------- */
/* Sub-components                                                         */
/* ---------------------------------------------------------------------- */

function TabBar({
  tab,
  onChange,
}: {
  tab: Tab;
  onChange: (t: Tab) => void;
}) {
  const tabs: { id: Tab; label: string }[] = [
    { id: "create", label: "Create" },
    { id: "join", label: "Join" },
    { id: "browse", label: "Browse" },
  ];
  return (
    <div
      role="tablist"
      aria-label="Multiplayer entry mode"
      className="grid grid-cols-3 gap-2"
    >
      {tabs.map((t) => {
        const active = tab === t.id;
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(t.id)}
            className={`border-2 px-3 py-2 font-mono text-[11.5px] uppercase tracking-widest transition-colors ${
              active
                ? "border-accent bg-accent/10 text-accent"
                : "border-bone-50/20 text-bone-50/65 hover:border-accent/60 hover:text-bone-50"
            }`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

function CreatePane({
  roomName,
  onRoomName,
  visibility,
  onVisibility,
  onSubmit,
  busy,
  disabled,
  conn,
}: {
  roomName: string;
  onRoomName: (n: string) => void;
  visibility: "public" | "private";
  onVisibility: (v: "public" | "private") => void;
  onSubmit: () => void;
  busy: boolean;
  disabled: boolean;
  conn: string;
}) {
  return (
    <div className="space-y-4">
      <label className="block">
        <span className="font-mono text-[10.5px] uppercase tracking-widest text-bone-50/60">
          Room name <span className="text-bone-50/35">(optional)</span>
        </span>
        <input
          type="text"
          value={roomName}
          onChange={(e) => onRoomName(e.target.value.slice(0, ROOM_NAME_MAX_LEN))}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !disabled) onSubmit();
          }}
          placeholder="room"
          maxLength={ROOM_NAME_MAX_LEN}
          autoComplete="off"
          spellCheck={false}
          className="mt-1 block w-full border-2 border-bone-50/20 bg-transparent px-3 py-2 font-mono text-[0.92rem] text-bone-50 outline-none focus:border-accent transition-colors"
        />
        <p className="mt-1 font-mono text-[9.5px] uppercase tracking-widest text-bone-50/40">
          Up to {ROOM_NAME_MAX_LEN} characters, no formatting.
        </p>
      </label>

      <fieldset className="block">
        <legend className="font-mono text-[10.5px] uppercase tracking-widest text-bone-50/60">
          Visibility
        </legend>
        <div className="mt-1 grid grid-cols-2 gap-2">
          <VisibilityChoice
            id="vis-private"
            label="Private"
            description="Code-only. Share the room code to invite friends."
            active={visibility === "private"}
            onSelect={() => onVisibility("private")}
            dot="○"
          />
          <VisibilityChoice
            id="vis-public"
            label="Public"
            description="Anyone can find and join this room from Browse."
            active={visibility === "public"}
            onSelect={() => onVisibility("public")}
            dot="●"
          />
        </div>
      </fieldset>

      <button
        onClick={onSubmit}
        disabled={disabled}
        className="brut-btn-accent group inline-flex w-full items-center justify-center gap-2 px-4 py-3 disabled:opacity-50"
      >
        {busy ? (
          <span>Creating…</span>
        ) : conn !== "connected" ? (
          <span>Waking server…</span>
        ) : (
          <>
            <span>Create room</span>
            <ArrowIcon
              direction="right"
              size={15}
              strokeWidth={2.75}
              className="transition-transform duration-200 group-hover:translate-x-0.5"
            />
          </>
        )}
      </button>
    </div>
  );
}

function VisibilityChoice({
  id,
  label,
  description,
  active,
  onSelect,
  dot,
}: {
  id: string;
  label: string;
  description: string;
  active: boolean;
  onSelect: () => void;
  dot: string;
}) {
  return (
    <button
      id={id}
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onSelect}
      className={`flex flex-col items-start gap-1 border-2 px-3 py-2 text-left transition-colors ${
        active
          ? "border-accent bg-accent/10"
          : "border-bone-50/20 hover:border-accent/60"
      }`}
    >
      <span
        className={`font-mono text-[11.5px] uppercase tracking-widest ${
          active ? "text-accent" : "text-bone-50/80"
        }`}
      >
        <span className="mr-1">{dot}</span>
        {label}
      </span>
      <span className="text-[10.5px] leading-snug text-bone-50/55">
        {description}
      </span>
    </button>
  );
}

function JoinPane({
  code,
  onCode,
  cleanCode,
  onSubmit,
  busy,
  disabled,
  conn,
}: {
  code: string;
  onCode: (c: string) => void;
  cleanCode: string;
  onSubmit: () => void;
  busy: boolean;
  disabled: boolean;
  conn: string;
}) {
  return (
    <div className="space-y-3">
      <label className="block">
        <span className="font-mono text-[10.5px] uppercase tracking-widest text-bone-50/60">
          Room code
        </span>
        <input
          type="text"
          value={code}
          onChange={(e) => onCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !disabled) onSubmit();
          }}
          placeholder="ROOM CODE"
          inputMode="text"
          maxLength={ROOM_CODE_LENGTH}
          autoComplete="off"
          spellCheck={false}
          className="mt-1 block w-full border-2 border-bone-50/20 bg-transparent px-3 py-3 text-center font-mono text-[1.05rem] uppercase tracking-[0.4em] text-bone-50 outline-none focus:border-accent transition-colors"
        />
        <p className="mt-1 font-mono text-[9.5px] uppercase tracking-widest text-bone-50/40">
          Six characters · A–Z, 2–9 · {cleanCode.length}/{ROOM_CODE_LENGTH}
        </p>
      </label>

      <button
        onClick={onSubmit}
        disabled={disabled}
        className="brut-btn group inline-flex w-full items-center justify-center gap-2 px-4 py-3 disabled:opacity-50"
      >
        {busy ? (
          <span>Joining…</span>
        ) : conn !== "connected" ? (
          <span>Waking server…</span>
        ) : (
          <>
            <span>Join</span>
            <ArrowIcon
              direction="right"
              size={15}
              strokeWidth={2.75}
              className="transition-transform duration-200 group-hover:translate-x-0.5"
            />
          </>
        )}
      </button>
    </div>
  );
}

function BrowsePane({
  actions,
  conn,
  onJoin,
  disabled,
  disabledReason,
}: {
  actions: ReturnType<typeof useRoomSocket>["actions"];
  conn: string;
  onJoin: (code: string) => void;
  disabled: boolean;
  disabledReason: string | null;
}) {
  const [rooms, setRooms] = useState<PublicRoomEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (conn !== "connected") return;
    setLoading(true);
    setFetchError(null);
    try {
      const list = await actions.listPublicRooms();
      // Sort: rooms in lobby first (joinable), then by recency.
      const sorted = [...list].sort((a, b) => {
        const aJoinable = a.phase === "lobby" ? 0 : 1;
        const bJoinable = b.phase === "lobby" ? 0 : 1;
        if (aJoinable !== bJoinable) return aJoinable - bJoinable;
        return b.createdAt - a.createdAt;
      });
      setRooms(sorted);
    } catch (e) {
      setFetchError(
        e instanceof Error ? e.message : "Failed to load public rooms",
      );
    } finally {
      setLoading(false);
    }
  }, [actions, conn]);

  // Auto-fetch on mount once we're connected, and when conn flips to
  // "connected" later (e.g. cold-start finally finished).
  useEffect(() => {
    if (conn === "connected" && rooms === null) {
      refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn]);

  // Light polling so the list stays fresh while users browse. 8s is
  // a balance between "feels live" and "not hammering the server".
  useEffect(() => {
    if (conn !== "connected") return;
    const t = setInterval(() => {
      refresh();
    }, 8_000);
    return () => clearInterval(t);
  }, [conn, refresh]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="font-mono text-[10.5px] uppercase tracking-widest text-bone-50/60">
          Public rooms{" "}
          {rooms && (
            <span className="text-bone-50/40">· {rooms.length}</span>
          )}
        </p>
        <button
          onClick={refresh}
          disabled={loading || conn !== "connected"}
          className="font-mono text-[10.5px] uppercase tracking-widest text-bone-50/70 hover:text-accent transition-colors disabled:opacity-40"
          title="Refresh list"
        >
          {loading ? "…refreshing" : "↻ refresh"}
        </button>
      </div>

      {fetchError && (
        <div className="border-2 border-rose-500 p-2 font-mono text-[0.79rem] text-rose-400">
          {fetchError}
        </div>
      )}

      {rooms === null && conn !== "connected" && (
        <div className="brut-card flex items-center gap-3 p-4">
          <span className="inline-block h-[1.05rem] w-[1.05rem] shrink-0 animate-spin rounded-full border-2 border-bone-50/20 border-t-accent" />
          <p className="font-mono text-[0.79rem] uppercase tracking-widest text-bone-50/70">
            Waiting for the server…
          </p>
        </div>
      )}

      {rooms && rooms.length === 0 && (
        <div className="border-2 border-dashed border-bone-50/20 px-4 py-6 text-center">
          <p className="font-mono text-[10.5px] uppercase tracking-widest text-bone-50/55">
            No public rooms right now
          </p>
          <p className="mt-1 text-[11.5px] text-bone-50/55">
            Be the first — flip to{" "}
            <span className="text-bone-50/80">Create</span> and set
            visibility to public.
          </p>
        </div>
      )}

      {rooms && rooms.length > 0 && (
        <ul className="max-h-[22rem] space-y-1.5 overflow-y-auto pr-1">
          {rooms.map((r) => (
            <PublicRoomRow
              key={r.code}
              room={r}
              onJoin={() => onJoin(r.code)}
              disabled={disabled}
              disabledReason={disabledReason}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function PublicRoomRow({
  room,
  onJoin,
  disabled,
  disabledReason,
}: {
  room: PublicRoomEntry;
  onJoin: () => void;
  disabled: boolean;
  disabledReason: string | null;
}) {
  const inProgress = room.phase !== "lobby";
  const full = room.playerCount >= room.maxPlayers;
  const joinDisabled = disabled || inProgress || full;
  const reason = disabledReason
    ? disabledReason
    : full
      ? "Room is full"
      : inProgress
        ? `Match in progress (${room.phase})`
        : "Join this room";
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-2 border-bone-50/15 px-3 py-2 transition-colors hover:border-accent/60">
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <p
            className="truncate font-display text-[0.97rem] font-bold text-bone-50"
            title={room.name}
          >
            {room.name}
          </p>
          <span
            className={`font-mono text-[9.5px] uppercase tracking-widest ${
              inProgress ? "text-yellow-400" : "text-accent"
            }`}
          >
            {inProgress ? `· ${room.phase}` : "· open"}
          </span>
        </div>
        <p className="mt-0.5 truncate font-mono text-[10.5px] uppercase tracking-widest text-bone-50/55">
          host {room.hostName} · {room.playerCount}/{room.maxPlayers}
          {room.selectedSong && (
            <>
              <span className="text-bone-50/30"> · </span>
              <span className="normal-case tracking-normal text-bone-50/65">
                {room.selectedSong}
              </span>
            </>
          )}
        </p>
      </div>
      <button
        onClick={onJoin}
        disabled={joinDisabled}
        title={reason}
        className="brut-btn group inline-flex shrink-0 items-center gap-2 px-3 py-2 font-mono text-[10.5px] uppercase tracking-widest disabled:opacity-40"
      >
        <span>Join</span>
        <ArrowIcon
          direction="right"
          size={12}
          strokeWidth={2.75}
          className="transition-transform duration-200 group-hover:translate-x-0.5"
        />
      </button>
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
      className={`inline-flex w-fit items-center gap-2 border-2 px-3 py-1.5 font-mono text-[10.5px] uppercase tracking-widest ${color}`}
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
