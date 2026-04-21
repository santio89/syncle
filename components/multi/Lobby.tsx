"use client";

/**
 * Multiplayer lobby. Three regions on a wide screen:
 *
 *   1. Roster (left column, top)
 *      - Everyone in the room with host crown / online dot.
 *      - Your own row sprouts a [READY] toggle.
 *      - Host's view of other rows sprouts [mute] / [kick] icon buttons.
 *      - Muted players show a small "muted" pill.
 *
 *   2. Chat (left column, bottom)
 *      - Live chat for everyone in the room. Reusable component, also
 *        used during the loading + results phases.
 *
 *   3. Settings + host/guest pane (right column, wider)
 *      - Per-player settings card on top (volume / metronome / FPS /
 *        feedback) so it lands above the room-level controls.
 *      - Below it: Host pane (song picker, difficulty buttons, start
 *        button), Guest pane ("waiting on host" + selected-song
 *        preview), or Match-in-progress pane (live scoreboard +
 *        playing song + progress) depending on `phase` + `isHost`.
 *      - Wider column because the song catalog table is the largest
 *        single piece of content in the lobby.
 *
 * Start contract:
 *   - The host always clicks "Start match" themselves — there is no
 *     auto-start. The all-ready quorum bar is purely informational; it
 *     tells the host "you can start now without overriding anyone",
 *     but the actual moment of starting is a deliberate host action so
 *     they can wait for late friends, swap songs, etc.
 *   - The host's currently-highlighted difficulty is mirrored to the
 *     server via `actions.setMode` on every picker tap so the server
 *     has a canonical record of the queued tier.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ArrowIcon } from "@/components/icons/ArrowIcon";
import { CopyToast } from "@/components/CopyToast";
import ScrollStrip from "@/components/ScrollStrip";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import type { RoomActions } from "@/hooks/useRoomSocket";
import type { ChartMode, ModeAvailability } from "@/lib/game/chart";
import {
  displayMode,
  MODE_ORDER,
  modeStars,
  probeSongModes,
} from "@/lib/game/chart";
import {
  loadFpsLock,
  loadMetronome,
  loadSfx,
  loadVolume,
  nextFpsLock,
  saveFpsLock,
  saveMetronome,
  saveSfx,
  saveVolume,
  type FpsLock,
} from "@/lib/game/settings";
import type {
  CatalogItem,
  ChatMessage,
  PlayerSnapshot,
  RoomSnapshot,
  ScoreboardEntry,
  SongRef,
} from "@/lib/multi/protocol";
import {
  MAX_PLAYERS_PER_ROOM,
  NAME_MAX_LEN,
  ROOM_NAME_MAX_LEN,
} from "@/lib/multi/protocol";

import { ChatPanel } from "./ChatPanel";

// Single horizontal slider — see HostPane render. Used to be split
// across two grid rows (easy/normal/hard + insane/expert) but the
// stacked layout was eating ~2x the vertical space the picker
// actually needs, which made the lobby card grow taller than the
// chat / roster columns at typical viewport heights. A single
// horizontally-scrollable strip keeps the picker at one row tall
// regardless of breakpoint; the strip wraps to a flex slider with
// drag-to-pan when the container can't fit all five buttons.
const MODES: ChartMode[] = ["easy", "normal", "hard", "insane", "expert"];

export function Lobby({
  code,
  snapshot,
  scoreboard,
  meId,
  isHost,
  chat,
  actions,
}: {
  code: string;
  snapshot: RoomSnapshot;
  /**
   * Live scoreboard fan-out from the server. Empty during the
   * lobby phase; populated mid-match. Only consumed by the
   * match-in-progress pane (right column when `snapshot.phase !==
   * "lobby"`); the lobby phase itself doesn't render scores.
   */
  scoreboard: ScoreboardEntry[];
  meId: string;
  isHost: boolean;
  chat: ChatMessage[];
  actions: RoomActions;
}) {
  const me = snapshot.players.find((p) => p.id === meId);
  // Online-or-offline doesn't matter for "is this player ready" (offline
  // players aren't included in the all-ready quorum) but we still want
  // to render them in the roster so the host can see them and decide
  // whether to wait or kick.
  const onlinePlayers = snapshot.players.filter((p) => p.online);
  const allReady =
    onlinePlayers.length > 0 && onlinePlayers.every((p) => p.lobbyReady);
  // Match-in-progress mode: this Lobby is being rendered for a
  // late-joiner / leaver while the rest of the room is past the
  // lobby phase. We swap the host/guest pane on the right for a
  // compact "match in progress" panel and decorate the roster with
  // small "in match" badges so the watcher can see who's playing.
  const matchInProgress = snapshot.phase !== "lobby";

  return (
    // Narrower column on the LEFT (roster + chat — fixed-width
    // social panel). Wider column on the RIGHT for settings + the
    // host pane, since the song catalog table is the single biggest
    // chunk of content in the lobby (filter input + 10+ rows of
    // catalog + difficulty grid + start button). 1 / 1.4 ratio.
    //
    // On `lg+` the grid claims the full viewport height (cascaded
    // from the page wrapper via `lg:h-full lg:min-h-0`) so each
    // column can carry its own internal scrollers (roster /
    // catalog / chat) instead of letting any one card push the
    // whole page into a scroll state. On smaller breakpoints the
    // grid collapses to a single column and the page scrolls
    // naturally — appropriate for phones / tablets where
    // everything stacks vertically anyway.
    <div className="grid grid-cols-1 gap-6 lg:h-full lg:min-h-0 lg:grid-cols-[minmax(280px,1fr)_minmax(0,1.4fr)]">
      {/* Left column: roster on top, chat below. Both cards share
          `brut-card` styling so they read as one "people in this
          room" panel. Roster sits on top because it has fixed
          structural info (head count, ready quorum, mark-ready
          button) that the user wants to glance at; chat is
          conversational and drifts to the bottom where it can grow
          vertically without pushing anything important out of view. */}
      <div className="flex flex-col gap-4 lg:h-full lg:min-h-0">
        <PlayerRoster
          snapshot={snapshot}
          meId={meId}
          iAmHost={isHost}
          actions={actions}
          allReady={allReady}
          matchInProgress={matchInProgress}
        />
        {/* Chat wrapper:
            - Mobile / tablet (`< lg`): fixed `h-[36rem]` so the
              input doesn't drift off-screen on a long chat — the
              page scrolls to reach it and the inner scroller
              handles message overflow.
            - Desktop (`lg+`): `flex-1 min-h-0` so chat fills
              whatever vertical space remains under the roster,
              with `min-h-[20rem]` as a floor so it never collapses
              to a sliver. The inner messages area inside ChatPanel
              auto-scrolls to the bottom on new messages and
              pauses auto-scroll while you're reading history —
              so the full server backlog (capped at
              MAX_CHAT_HISTORY = 100) is always reachable by
              scrolling inside the panel. */}
        <div className="h-[36rem] min-h-[20rem] lg:h-auto lg:min-h-0 lg:flex-1">
          <ChatPanel
            chat={chat}
            meId={meId}
            meIsMuted={!!me?.muted}
            onSend={actions.sendChat}
          />
        </div>
      </div>

      {/* Right column: your settings on top, then the host / guest /
          match-in-progress pane underneath. Settings sits at the TOP
          because:
          - It's PER-PLAYER (like the rename / ready buttons in the
            roster card), not room state, so it lands at the
            natural reading entry point.
          - First-time players land in a lobby and immediately see
            volume / metronome / FPS / feedback controls without
            having to scroll past anything — important since the
            next thing that happens is a song firing.
          - The host pane is much TALLER than settings (catalog +
            picker + start button), so putting settings above keeps
            it pinned in the viewport instead of getting buried.

          The pane below is a three-way switch between host pane,
          guest pane, and match-in-progress watcher pane. The
          watcher pane wins whenever the room is past the lobby —
          even for the host (who only ends up here in the unusual
          case of being a late-joiner who got promoted on the
          original host's disconnect). The host can't restart
          anything mid-match (server gates `host:start` on
          `phase === "lobby"`), so a full HostPane during the match
          would just be a wall of disabled controls. The watcher
          pane is more useful: it shows what's playing and the
          live scoreboard so the host knows what they're walking
          into when the round ends. */}
      <div className="flex flex-col gap-4 lg:h-full lg:min-h-0">
        <PlayerSettingsCard />
        {/* Pane wrapper: takes the rest of the column on `lg+` so
            the host pane's catalog scroller can grow into the
            available height instead of being capped at a fixed
            ~24rem. Each pane root carries `flex h-full flex-col`
            already, so `lg:flex-1 lg:min-h-0` here is the only
            extra plumbing needed. */}
        <div className="lg:flex-1 lg:min-h-0">
          {matchInProgress ? (
            <MatchInProgressPane
              snapshot={snapshot}
              scoreboard={scoreboard}
            />
          ) : isHost ? (
            <HostPane
              snapshot={snapshot}
              actions={actions}
              code={code}
              allReady={allReady}
            />
          ) : (
            <GuestPane snapshot={snapshot} />
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Roster                                                                   */
/* ------------------------------------------------------------------------ */

function PlayerRoster({
  snapshot,
  meId,
  iAmHost,
  actions,
  allReady,
  matchInProgress,
}: {
  snapshot: RoomSnapshot;
  meId: string;
  iAmHost: boolean;
  actions: RoomActions;
  allReady: boolean;
  matchInProgress: boolean;
}) {
  const me = snapshot.players.find((p) => p.id === meId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const commit = useCallback(() => {
    const name = draft.trim();
    if (name) actions.setName(name);
    setEditing(false);
  }, [draft, actions]);

  const readyCount = snapshot.players.filter(
    (p) => p.online && p.lobbyReady,
  ).length;
  const onlineCount = snapshot.players.filter((p) => p.online).length;

  return (
    <div className="brut-card flex flex-col p-5 sm:p-6">
      <div className="flex items-baseline justify-between gap-3">
        <p className="font-mono text-[10.5px] uppercase tracking-[0.4em] text-accent">
          ░ Players
        </p>
        <span className="font-mono text-[10.5px] uppercase tracking-widest text-bone-50/50">
          {snapshot.players.length} / {MAX_PLAYERS_PER_ROOM}
        </span>
      </div>

      {/* Ready quorum bar — only visible during the lobby phase. While
          a match is in progress the "ready" signal is irrelevant
          (everyone in the match was pulled in at start time; watchers
          in the lobby aren't waiting for a ready check), so collapsing
          it cuts visual noise and the watcher's eyes go straight to
          the roster + match-progress panel on the right. */}
      {!matchInProgress && (
        <ReadyQuorumBar
          ready={readyCount}
          total={onlineCount}
          allReady={allReady}
        />
      )}

      {/* Roster has its own scroller capped at ~22rem (≈ 8-10
          rows) so a near-full 50-player room doesn't push the
          rename + Mark Ready strip off-screen. The internal
          scrollbar lives flush against the card's right edge —
          that's expected here because the roster is a
          self-contained "list-with-its-own-scroll" widget,
          symmetric with the host pane's catalog scroller.
          `pr-1` keeps the scrollbar thumb from sitting flush
          against the row borders. */}
      <ul className="mt-3 max-h-[22rem] space-y-1.5 overflow-y-auto pr-1">
        {snapshot.players.map((p) => (
          <RosterRow
            key={p.id}
            player={p}
            isMe={p.id === meId}
            iAmHost={iAmHost}
            actions={actions}
            matchInProgress={matchInProgress}
          />
        ))}
      </ul>

      {/* "You" controls strip: ready toggle + rename. The ready button
          is the BIG ACTION here — uppercase, accent-filled when on,
          and a DIMMED version of the same look when off. Sharing the
          shape across both states (solid accent border + accent
          shadow, just attenuated) keeps the hover/click feedback feel
          consistent and makes the on/off toggle read as "saturate /
          desaturate the same control" rather than "swap between two
          totally different buttons".

          Hidden entirely while a match is in progress — there's no
          round to be "ready for", and the next round will reset
          everyone's ready state on `transitionToLobby` anyway. The
          rename row is still useful (watchers can adjust their name
          before joining the next round), so it stays. */}
      <div className="mt-4 space-y-3 border-t-2 border-bone-50/10 pt-3">
        {/* Rename row sits ABOVE Mark Ready — Mark Ready is the
            primary action (big saturated button) and lives at the
            very bottom of the card so it's the last thing the eye
            lands on after scanning the roster top-to-bottom. The
            quieter rename text-button slots in just under the
            roster divider where it's easy to find but doesn't
            compete with the call-to-action. */}
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
              setDraft(me?.name ?? "");
              setEditing(true);
            }}
            className="inline-flex items-center gap-2 font-mono text-[0.79rem] uppercase tracking-widest text-bone-50/70 hover:text-accent"
          >
            <span>rename player</span>
          </button>
        )}

        {me && !matchInProgress && (
          <button
            onClick={() => actions.setReady(!me.lobbyReady)}
            className={`w-full border-2 px-4 py-3 font-mono text-[0.86rem] uppercase tracking-[0.3em] transition-colors ${
              me.lobbyReady
                ? "border-accent bg-accent text-ink-900 shadow-[6px_6px_0_rgb(var(--shadow-accent))]"
                : "border-accent/40 bg-accent/5 text-accent/75 shadow-[6px_6px_0_rgb(var(--shadow-accent)/0.35)] hover:border-accent hover:bg-accent/10 hover:text-accent"
            }`}
            data-tooltip={
              me.lobbyReady
                ? "Click to un-ready"
                : "Mark yourself ready so the host knows you're set"
            }
          >
            {me.lobbyReady ? "✓ Ready" : "Mark ready"}
          </button>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Per-player settings card                                                 */
/* ------------------------------------------------------------------------ */

/**
 * Compact settings panel mirroring the single-player StartCard's
 * settings strip (FPS lock + Metronome + Feedback as a tile row,
 * Music volume slider in its own tile below).
 *
 * Why per-player and self-contained:
 *   - These are LOCAL preferences, not room state. They never get sent
 *     over the wire — every player adjusts their own and they take
 *     effect for them only. So the card has no `actions` prop and no
 *     callbacks back into the lobby; it just reads / writes the same
 *     `lib/game/settings` localStorage keys the single-player Game.tsx
 *     and the in-game MultiGame.tsx use.
 *   - When the match starts, MultiGame's useState initialisers call
 *     loadVolume() / loadMetronome() / loadSfx() / loadFpsLock() on
 *     mount, so any nudge made in the lobby is automatically picked
 *     up — no protocol round-trip needed.
 *   - Visual style matches the single-player StartCard exactly (same
 *     tile borders, captions, accent colors, slider treatment) so a
 *     player who knows the solo settings panel feels at home here
 *     immediately.
 *
 * Save semantics:
 *   - Each control persists IMMEDIATELY on change (no Apply button).
 *     This matches the StartCard pattern and avoids the "did my
 *     setting save?" question that confirm-style panels create.
 *   - The volume slider is shown live in % (perceptual scale, see
 *     audio.ts perceivedToGain) so the number on screen matches the
 *     mental model the player has from solo play.
 */
function PlayerSettingsCard() {
  const [volume, setVolumeState] = useState<number>(loadVolume);
  const [metronome, setMetronomeState] = useState<boolean>(loadMetronome);
  const [sfx, setSfxState] = useState<boolean>(loadSfx);
  const [fpsLock, setFpsLockState] = useState<FpsLock>(loadFpsLock);

  // Live-save handlers — persist on every change so closing the lobby
  // tab without a final "save" still keeps the player's choices.
  const onVolume = useCallback((v: number) => {
    setVolumeState(v);
    saveVolume(v);
  }, []);
  const onToggleMetronome = useCallback(() => {
    setMetronomeState((cur) => {
      const next = !cur;
      saveMetronome(next);
      return next;
    });
  }, []);
  const onToggleSfx = useCallback(() => {
    setSfxState((cur) => {
      const next = !cur;
      saveSfx(next);
      return next;
    });
  }, []);
  const onCycleFpsLock = useCallback(() => {
    setFpsLockState((cur) => {
      const next = nextFpsLock(cur);
      saveFpsLock(next);
      return next;
    });
  }, []);

  return (
    <div className="brut-card flex flex-col p-5 sm:p-6">
      <div className="flex items-baseline justify-between gap-3">
        <p className="font-mono text-[10.5px] uppercase tracking-[0.4em] text-accent">
          ░ Settings
        </p>
      </div>

      {/* Three-tile row: FPS lock + Metronome + Feedback. Same
          dimensions and dressing as the StartCard tiles so the two
          panels feel like one product. On narrow widths the grid
          collapses to a single column — keyboard / touch targets stay
          a comfortable size all the way down to phone widths. */}
      <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <button
          type="button"
          onClick={onCycleFpsLock}
          className="flex cursor-pointer flex-col justify-between gap-1 border-2 border-bone-50/30 bg-ink-900/50 px-3 py-2 text-left"
          data-tooltip={
            fpsLock == null
              ? "FPS lock off — click to cap at 30 FPS"
              : `Render frame-rate capped at ${fpsLock} FPS — click to ${
                  fpsLock === 30 ? "cap at 60" : "uncap"
                }`
          }
          aria-label="Cycle render FPS lock"
        >
          <div className="flex items-center justify-between gap-3">
            <span className="font-mono text-[10.5px] uppercase tracking-widest text-bone-50/70">
              FPS lock
            </span>
            <span
              aria-hidden
              className={`font-mono text-[10px] uppercase tracking-widest transition-colors ${
                fpsLock == null ? "text-bone-50/60" : "text-accent"
              }`}
            >
              {fpsLock == null ? "OFF" : fpsLock}
            </span>
          </div>
          <span className="font-mono text-[9.5px] text-bone-50/40">
            click to cycle off / 30 / 60
          </span>
        </button>

        <label
          className="flex cursor-pointer flex-col justify-between gap-1 border-2 border-bone-50/30 bg-ink-900/50 px-3 py-2"
          data-tooltip="Toggle the audible click track that plays on every beat"
        >
          <div className="flex items-center justify-between gap-3">
            <span className="font-mono text-[10.5px] uppercase tracking-widest text-bone-50/70">
              Metronome
            </span>
            <input
              type="checkbox"
              checked={metronome}
              onChange={onToggleMetronome}
              className="h-[1.05rem] w-[1.05rem] cursor-pointer accent-accent"
              aria-label="Toggle metronome"
              aria-keyshortcuts="M"
            />
          </div>
          <span className="font-mono text-[9.5px] text-bone-50/40">
            press M to toggle in-game
          </span>
        </label>

        <label
          className="flex cursor-pointer flex-col justify-between gap-1 border-2 border-bone-50/30 bg-ink-900/50 px-3 py-2"
          data-tooltip="Toggle hit / miss / release tones on key press"
        >
          <div className="flex items-center justify-between gap-3">
            <span className="font-mono text-[10.5px] uppercase tracking-widest text-bone-50/70">
              Feedback
            </span>
            <input
              type="checkbox"
              checked={sfx}
              onChange={onToggleSfx}
              className="h-[1.05rem] w-[1.05rem] cursor-pointer accent-accent"
              aria-label="Toggle input sound effects"
              aria-keyshortcuts="N"
            />
          </div>
          <span className="font-mono text-[9.5px] text-bone-50/40">
            press N to toggle in-game
          </span>
        </label>
      </div>

      {/* Volume tile sits on its own row at full width — the slider
          needs the horizontal real estate to be precise, and pairing
          it with the percentage readout in the header line keeps the
          control compact while still showing the live value. */}
      <div className="mt-2 border-2 border-bone-50/30 bg-ink-900/50 px-3 py-2">
        <div className="flex items-center justify-between gap-3">
          <span className="font-mono text-[10.5px] uppercase tracking-widest text-bone-50/70">
            Music volume
          </span>
          <span className="font-mono text-[10.5px] tabular-nums text-bone-50/40">
            {Math.round(volume * 100)}%
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={(e) => onVolume(parseFloat(e.target.value))}
          className="mt-1.5 h-1 w-full cursor-pointer accent-accent"
          aria-label="Music volume"
        />
      </div>
    </div>
  );
}

function ReadyQuorumBar({
  ready,
  total,
  allReady,
}: {
  ready: number;
  total: number;
  allReady: boolean;
}) {
  if (total === 0) return null;
  const pct = Math.round((ready / total) * 100);
  return (
    <div className="mt-3 space-y-1">
      <div className="flex items-baseline justify-between font-mono text-[9.5px] uppercase tracking-widest text-bone-50/55">
        <span>
          {allReady ? "All ready" : "Ready quorum"}
        </span>
        <span className={allReady ? "text-accent" : "text-bone-50/70"}>
          {ready} / {total}
        </span>
      </div>
      <div className="relative h-1.5 border-2 border-bone-50/15 bg-transparent">
        <div
          className={`h-full transition-all duration-300 ease-out ${
            allReady ? "bg-accent animate-pulse" : "bg-accent/70"
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function RosterRow({
  player,
  isMe,
  iAmHost,
  actions,
  matchInProgress,
}: {
  player: PlayerSnapshot;
  isMe: boolean;
  iAmHost: boolean;
  actions: RoomActions;
  matchInProgress: boolean;
}) {
  // Host actions surface on hover for desktop and via a small toolbar
  // for keyboard / touch. They're omitted entirely on the host's own
  // row (hosts don't kick or mute themselves).
  const showHostActions = iAmHost && !player.isHost;
  // During a match, the dot's "ready" semantic stops applying — what
  // the watcher actually wants to know is "is this person playing
  // right now, or are they here in the lobby with me?". We light the
  // dot accent for in-match players and dim it for in-lobby players,
  // mirroring the at-a-glance affordance the lobby-phase ready dot
  // provides without inventing a new symbol.
  const dotClass = !player.online
    ? "bg-bone-50/30"
    : matchInProgress
      ? player.inMatch
        ? "bg-accent"
        : "bg-bone-50/30"
      : player.lobbyReady
        ? "bg-accent"
        : "bg-accent/40";
  const dotTooltip = !player.online
    ? "Disconnected"
    : matchInProgress
      ? player.inMatch
        ? "Playing this match"
        : "Watching from the lobby"
      : player.lobbyReady
        ? "Ready"
        : "Online — not ready";
  return (
    <li className="group flex items-center gap-2 border-2 border-bone-50/10 px-3 py-2">
      <span
        className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`}
        data-tooltip={dotTooltip}
      />
      <span
        className={`flex-1 truncate font-mono text-[0.92rem] ${
          player.online ? "text-bone-50/90" : "text-bone-50/40"
        }`}
      >
        {player.name || "—"}
        {isMe && (
          <span className="ml-1 font-mono text-[9.5px] uppercase tracking-widest text-accent">
            you
          </span>
        )}
      </span>

      {/* Status pills (mute, ready/in-match, host) — small, uppercase,
          mono. While a match is in progress we swap the lobby-only
          "ready" pill for an "in match" pill so the watcher sees, at
          a glance, who they're spectating vs who else is sitting in
          the lobby with them. */}
      <span className="flex shrink-0 items-center gap-1.5">
        {player.muted && (
          <span
            className="border border-rose-500/60 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest text-rose-400"
            data-tooltip="Chat muted by host"
          >
            muted
          </span>
        )}
        {matchInProgress
          ? player.inMatch && (
              <span
                className="border border-accent/70 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest text-accent"
                data-tooltip="Currently playing this match"
              >
                in match
              </span>
            )
          : player.lobbyReady && (
              <span
                className="border border-accent/70 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest text-accent"
                data-tooltip="Ready to play"
              >
                ready
              </span>
            )}
        {player.isHost && (
          <span
            className="font-mono text-[9.5px] uppercase tracking-widest text-accent"
            data-tooltip="Room host"
          >
            ★ host
          </span>
        )}
      </span>

      {showHostActions && (
        <span className="ml-1 flex shrink-0 items-center gap-1 opacity-60 transition-opacity group-hover:opacity-100">
          <HostIconButton
            label={player.muted ? "Unmute" : "Mute"}
            onClick={() => actions.mute(player.id, !player.muted)}
          >
            {player.muted ? <UnmuteIcon /> : <MuteIcon />}
          </HostIconButton>
          <HostIconButton
            label="Kick"
            danger
            onClick={() => actions.kick(player.id)}
          >
            <KickIcon />
          </HostIconButton>
        </span>
      )}
    </li>
  );
}

function HostIconButton({
  label,
  danger,
  onClick,
  children,
}: {
  label: string;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-tooltip={label}
      aria-label={label}
      className={`inline-flex h-7 w-7 items-center justify-center border-2 transition-colors ${
        danger
          ? "border-rose-500/40 text-rose-400 hover:border-rose-500 hover:bg-rose-500/15"
          : "border-bone-50/20 text-bone-50/70 hover:border-accent hover:text-accent"
      }`}
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------------ */
/* SVG icons (kept inline so we don't pollute components/icons/ for one-off use) */
/* ------------------------------------------------------------------------ */

function KickIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square">
      <line x1="2" y1="2" x2="10" y2="10" />
      <line x1="10" y1="2" x2="2" y2="10" />
    </svg>
  );
}

function MuteIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square">
      <path d="M2 4.5h2L7 2v8L4 7.5H2z" />
      <line x1="9" y1="3.5" x2="11.5" y2="6" />
      <line x1="11.5" y1="3.5" x2="9" y2="6" />
    </svg>
  );
}

function UnmuteIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square">
      <path d="M2 4.5h2L7 2v8L4 7.5H2z" />
      <path d="M9 3.5c1 .8 1 4.2 0 5" />
    </svg>
  );
}

/* ------------------------------------------------------------------------ */
/* Host pane                                                                */
/* ------------------------------------------------------------------------ */

function HostPane({
  snapshot,
  actions,
  code,
  allReady,
}: {
  snapshot: RoomSnapshot;
  actions: RoomActions;
  code: string;
  allReady: boolean;
}) {
  const [mode, setMode] = useState<ChartMode>("easy");
  // Search input. Drives upstream catalog search when non-empty; when
  // empty the lobby falls back to paginated browse (newest ranked
  // first). Renamed from the old `filter` (which was a local
  // Array.filter against a 100-item random slice) to make the new
  // behavior explicit at call sites.
  const [query, setQuery] = useState("");
  // Debounced copy of `query` — the input updates per-keystroke for
  // snappy UI feedback, but we only fire upstream requests when the
  // user pauses typing for ~300 ms. Without this the host typing
  // "spectre" would fire 7 mirror requests; with it, exactly 1.
  const [debouncedQuery, setDebouncedQuery] = useState("");
  // Browse-mode state (no query, paginated by ranked_desc by default).
  // The `browseRefreshTick` int is bumped by the ↻ button to force a
  // re-fetch of the current page even if React would otherwise skip
  // it (no other dep changed) — also tells the effect to send
  // `refresh: true` upstream so the server bypasses its 5-min cache.
  const [browsePage, setBrowsePage] = useState(0);
  const [browseRefreshTick, setBrowseRefreshTick] = useState(0);
  const [browseResults, setBrowseResults] = useState<CatalogItem[] | null>(null);
  const [browseHasMore, setBrowseHasMore] = useState(false);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [browseSource, setBrowseSource] = useState<string | null>(null);
  const browseReqId = useRef(0);
  // Search-mode state (text query, paginated).
  const [searchPage, setSearchPage] = useState(0);
  const [searchResults, setSearchResults] = useState<CatalogItem[] | null>(null);
  const [searchHasMore, setSearchHasMore] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchSource, setSearchSource] = useState<string | null>(null);
  // Monotonic request id — debounced typing guarantees only the latest
  // (query, page) pair gets to update React state. Without this, a
  // slow page-1 response could land AFTER the user has already
  // navigated to page 2, overwriting newer results with stale ones.
  const searchReqId = useRef(0);
  // The "starting" state is now driven entirely by the server snapshot
  // (`prestartEndsAt !== null`). The 3 s prestart countdown overlay
  // doubles as the click debounce — between click and next snapshot the
  // server is idempotent on `host:start`, so we don't need a local
  // optimistic flag. See PRESTART_COUNTDOWN_MS in `lib/server/io.ts`.
  const starting = snapshot.prestartEndsAt !== null;

  // Per-song probe — see previous comment block.
  const [modeProbe, setModeProbe] = useState<ModeAvailability | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);
  const probeReqId = useRef(0);

  // Browse-mode fetch. Fires whenever `browsePage` changes (Prev/Next)
  // OR when `browseRefreshTick` is bumped by the ↻ button. The refresh
  // tick also flips the upstream `refresh` flag so the server bypasses
  // its 5-min cache for that page — without it, ↻ inside the TTL
  // window would just re-render the same cached payload and feel
  // broken to the host.
  useEffect(() => {
    const reqId = ++browseReqId.current;
    const isRefresh = browseRefreshTick > 0;
    setBrowseLoading(true);
    setBrowseError(null);
    actions
      .browseCatalog(browsePage, isRefresh ? { refresh: true } : undefined)
      .then((res) => {
        if (reqId !== browseReqId.current) return;
        if (!res) {
          setBrowseResults([]);
          setBrowseHasMore(false);
          setBrowseSource(null);
          setBrowseError("Failed to load catalog — try again.");
          return;
        }
        setBrowseResults(res.items);
        setBrowseHasMore(res.hasMore);
        setBrowseSource(res.source);
      })
      .catch((e: unknown) => {
        if (reqId !== browseReqId.current) return;
        const msg = e instanceof Error ? e.message : "Failed to load catalog";
        setBrowseResults([]);
        setBrowseHasMore(false);
        setBrowseSource(null);
        setBrowseError(msg);
      })
      .finally(() => {
        if (reqId !== browseReqId.current) return;
        setBrowseLoading(false);
      });
  }, [browsePage, browseRefreshTick, actions]);

  // Typing debounce. 300 ms was tuned from feel:
  // shorter than that and a normal-pace typist still fires 2-3 mid-
  // word requests; longer and feels laggy after the user has clearly
  // stopped. Reset `searchPage` to 0 whenever the query changes —
  // paging always starts at the top of a new query.
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedQuery(query.trim());
      setSearchPage(0);
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  // Whenever the debounced query OR the page changes, fetch the
  // matching upstream page. An empty debounced query short-circuits
  // back to the random-browse `catalog` view, so we clear search
  // state instead of firing a request.
  useEffect(() => {
    if (!debouncedQuery) {
      setSearchResults(null);
      setSearchHasMore(false);
      setSearchLoading(false);
      setSearchError(null);
      setSearchSource(null);
      return;
    }
    const reqId = ++searchReqId.current;
    setSearchLoading(true);
    setSearchError(null);
    actions
      .searchCatalog(debouncedQuery, searchPage)
      .then((res) => {
        // Stale response — the user typed (or paged) past this
        // request before it landed. Drop it without touching state.
        if (reqId !== searchReqId.current) return;
        if (!res) {
          setSearchResults([]);
          setSearchHasMore(false);
          setSearchSource(null);
          setSearchError("Search failed — try again.");
          return;
        }
        setSearchResults(res.items);
        setSearchHasMore(res.hasMore);
        setSearchSource(res.source);
      })
      .catch((e: unknown) => {
        if (reqId !== searchReqId.current) return;
        const msg = e instanceof Error ? e.message : "Search failed";
        setSearchResults([]);
        setSearchHasMore(false);
        setSearchSource(null);
        setSearchError(msg);
      })
      .finally(() => {
        if (reqId !== searchReqId.current) return;
        setSearchLoading(false);
      });
  }, [debouncedQuery, searchPage, actions]);

  // Source of truth for the rendered list. Search mode (non-empty
  // debounced query) shows ONLY upstream search results — there's no
  // client-side filtering of the browse view because the user already
  // told us what they're looking for. Browse mode (empty query) shows
  // the paginated browse slice (newest ranked first by default).
  const inSearchMode = debouncedQuery.length > 0;
  const displayItems: CatalogItem[] = useMemo(() => {
    if (inSearchMode) return searchResults ?? [];
    return browseResults ?? [];
  }, [inSearchMode, searchResults, browseResults]);

  const selected = snapshot.selectedSong;

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
        setMode((current) => (modes.available[current] ? current : firstAvailableMode(modes)));
      })
      .catch((err) => {
        if (probeReqId.current !== reqId) return;
        setProbing(false);
        setProbeError(err?.message ?? "Couldn't read difficulty list");
      });
  }, [selected]);

  // Mirror the host's mode pick to the server on every change so the
  // server has a canonical record of the queued tier.
  useEffect(() => {
    actions.setMode(mode);
  }, [mode, actions]);

  const modeReady = !!modeProbe?.available[mode];
  const canStart =
    !!selected &&
    !starting &&
    !probing &&
    modeReady &&
    snapshot.players.some((p) => p.online);

  const handleStart = () => {
    if (!canStart) return;
    actions.startMatch(mode);
  };

  const { copy, copied } = useCopyToClipboard();

  return (
    <div className="brut-card flex h-full flex-col p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[10.5px] uppercase tracking-[0.4em] text-accent">
            ░ Host controls
          </p>
          {/* Room name + visibility badge sits where the H3 used to be —
              still tells the host what they're managing, but now also
              communicates whether other people can find this room. The
              host gets a small "edit" affordance so they can rebrand
              the room or flip it between public/private without
              leaving + recreating it (the changes propagate to every
              client + the public browser via the authoritative
              snapshot broadcast). */}
          <RoomTitleEditor
            name={snapshot.name}
            visibility={snapshot.visibility}
            onRename={actions.setRoomName}
            onVisibility={actions.setRoomVisibility}
          />
        </div>
        <div className="relative">
          <CopyToast visible={copied} />
          <button
            onClick={() => copy(code)}
            className="brut-btn inline-flex items-center gap-2 px-3 py-2 font-mono text-[0.86rem] uppercase tracking-wider"
            data-tooltip="Copy room code"
          >
            <span>{code}</span>
            <span aria-hidden className="text-[0.92rem] leading-none">
              ⧉
            </span>
          </button>
        </div>
      </div>

      {/* Selected preview. When a song IS picked the whole tile
          flips into the accent palette (blue border + faint blue
          fill + accent label) so the host's eye snaps to "yes, a
          song is queued" without having to read the text. The
          empty state stays neutral so it doesn't shout for
          attention before there's anything to confirm. */}
      <div
        className={`mt-4 border-2 px-3 py-2 transition-colors ${
          selected
            ? "border-accent/70 bg-accent/[0.06]"
            : "border-bone-50/20"
        }`}
      >
        <div className="flex items-center justify-between gap-3">
          <p
            className={`font-mono text-[10.5px] uppercase tracking-widest ${
              selected ? "text-accent" : "text-bone-50/50"
            }`}
          >
            Selected
          </p>
          {selected && (probing || probeError) && (
            <p
              className={`font-mono text-[9.5px] uppercase tracking-widest ${
                probeError ? "text-rose-400" : "text-accent/70"
              }`}
            >
              {probing ? "checking difficulties…" : "couldn't read difficulties"}
            </p>
          )}
        </div>
        {selected ? (
          <p
            className="mt-0.5 truncate font-mono text-[0.92rem]"
            data-tooltip={`${selected.artist} — ${selected.title}`}
          >
            <span className="text-accent/65">{selected.artist}</span>{" "}
            <span className="text-accent/40">—</span>{" "}
            <span className="font-bold text-accent">{selected.title}</span>
          </p>
        ) : (
          <p className="mt-0.5 font-mono text-[0.92rem] text-bone-50/40">
            nothing yet — pick from the catalog below
          </p>
        )}
      </div>

      {/* Catalog search row.
          - Empty input → random-browse mode: refresh button repulls
            the 100-item random slice.
          - Non-empty input → search mode: refresh button is hidden
            (a fresh search is one keystroke away anyway), and the
            input becomes a true text query against the upstream
            mirrors with pagination underneath the list.
          The single input drives both modes so the host doesn't
          need a separate "search vs filter" toggle — typing IS the
          mode switch. */}
      <div className="mt-4 flex items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search the full catalog by title or artist…"
          className="flex-1 border-2 border-bone-50/20 bg-transparent px-3 py-2 font-mono text-[0.79rem] text-bone-50 outline-none focus:border-accent"
        />
        {inSearchMode ? (
          <button
            onClick={() => setQuery("")}
            className="brut-btn px-3 py-2 text-[0.79rem]"
            data-tooltip="Clear search · back to browse"
          >
            ✕
          </button>
        ) : (
          <button
            onClick={() => setBrowseRefreshTick((t) => t + 1)}
            disabled={browseLoading}
            className="brut-btn px-3 py-2 text-[0.79rem] disabled:opacity-50"
            data-tooltip="Refresh this page (bypass cache)"
          >
            {browseLoading ? "…" : "↻"}
          </button>
        )}
      </div>

      {/* Catalog has its own internal scroller so the difficulty
          grid + Start button stay anchored near the bottom of the
          host pane instead of being pushed off-screen by a long
          catalog.
          - Mobile / tablet (`< lg`): capped at `max-h-[24rem]`
            (≈ 12-14 rows) so the host pane fits sensibly in a
            scrolling page flow.
          - Desktop (`lg+`): cap is lifted (`lg:max-h-none`) and
            `flex-1` lets the catalog absorb whatever vertical
            space remains in the host pane after the header,
            selected box, filter row, difficulty grid, and Start
            button — typically a much larger window than 24rem,
            which means more rows visible without scrolling.
          `min-h-[10rem]` keeps the loading / empty states from
          collapsing the table to nothing. */}
      <div className="mt-2 max-h-[24rem] min-h-[10rem] flex-1 overflow-y-auto border-2 border-bone-50/10 lg:max-h-none">
        {/* Errors are mode-specific. Browse errors come from
            `browseError`; search errors from `searchError`. Showing
            them in the same banner means the host always sees the
            relevant failure for the action they just took
            (paging vs typing). */}
        {(inSearchMode ? searchError : browseError) && (
          <p className="border-b-2 border-rose-500 p-3 font-mono text-[0.79rem] text-rose-400">
            {inSearchMode ? searchError : browseError}
          </p>
        )}
        {/* Loading state: separate copies per mode so the host knows
            WHAT is being fetched (a page vs their search). The browse
            loader only renders on the first load (no results yet);
            subsequent paginations show the previous page until the
            new one lands, which feels much less janky than blanking
            the list every Next click. */}
        {inSearchMode && searchLoading && (
          <p className="p-3 font-mono text-[0.79rem] text-bone-50/50">
            Searching “{debouncedQuery}”…
          </p>
        )}
        {!inSearchMode && browseLoading && browseResults === null && (
          <p className="p-3 font-mono text-[0.79rem] text-bone-50/50">
            Fetching osu!mania 4K candidates…
          </p>
        )}
        {/* Empty states. Each branch tells the host what to DO next
            (clear the search, paginate back, hit refresh) instead of
            a generic "nothing here". */}
        {!searchLoading &&
          !browseLoading &&
          displayItems.length === 0 &&
          (inSearchMode ? (
            <p className="p-3 font-mono text-[0.79rem] text-bone-50/40">
              {searchPage === 0
                ? `No 4K mania tracks found for “${debouncedQuery}”.`
                : "No more results on this page — try Prev."}
            </p>
          ) : (
            <p className="p-3 font-mono text-[0.79rem] text-bone-50/40">
              {browsePage === 0
                ? "No tracks available — try refreshing."
                : "No more results on this page — try Prev."}
            </p>
          ))}
        <ul>
          {displayItems.map((c) => {
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
                  {/* Right column: track length (m:ss) when the mirror
                      reported `total_length` for at least one 4K diff.
                      Falls back to the mirror name for legacy / cached
                      catalogs that pre-date the duration field, so the
                      column is never empty. `tabular-nums` keeps every
                      "1:23" vertically aligned across the list, which
                      is much easier to scan than left-justified mirror
                      names of varying width. */}
                  <span
                    className="shrink-0 font-mono text-[9.5px] uppercase tracking-widest tabular-nums text-bone-50/40"
                    data-tooltip={
                      c.durationSec !== undefined
                        ? `Track length · sourced from ${c.source}`
                        : `Source mirror · duration not reported`
                    }
                  >
                    {c.durationSec !== undefined
                      ? formatTrackLength(c.durationSec)
                      : c.source}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {/* Pagination — visible in both modes. Browse defaults to
          ranked_desc (newest ranked first), so Prev/Next walks back
          through ranked history. In search mode the same controls
          paginate over text-query results.
          The middle label tells the host WHICH view they're looking
          at (page number + the active mode tag + the mirror that
          served this page). The mirror tag is diagnostic — useful
          when results look weird, since different mirrors can
          disagree on ordering for the same query. */}
      <div className="mt-2 flex items-center justify-between gap-2 font-mono text-[0.7rem] text-bone-50/55">
        <button
          onClick={() =>
            inSearchMode
              ? setSearchPage((p) => Math.max(0, p - 1))
              : setBrowsePage((p) => Math.max(0, p - 1))
          }
          disabled={
            inSearchMode
              ? searchPage === 0 || searchLoading
              : browsePage === 0 || browseLoading
          }
          className="brut-btn px-2.5 py-1 text-[0.7rem] disabled:opacity-40"
          data-tooltip="Previous page"
        >
          ← Prev
        </button>
        <span className="tabular-nums">
          Page {(inSearchMode ? searchPage : browsePage) + 1}
          <span className="ml-2 text-bone-50/35">
            ·{" "}
            {inSearchMode
              ? `search`
              : `newest`}
          </span>
          {(inSearchMode ? searchSource : browseSource) && (
            <span className="ml-1 text-bone-50/35">
              · {inSearchMode ? searchSource : browseSource}
            </span>
          )}
        </span>
        <button
          onClick={() =>
            inSearchMode
              ? setSearchPage((p) => p + 1)
              : setBrowsePage((p) => p + 1)
          }
          disabled={
            inSearchMode
              ? !searchHasMore || searchLoading
              : !browseHasMore || browseLoading
          }
          className="brut-btn px-2.5 py-1 text-[0.7rem] disabled:opacity-40"
          data-tooltip={
            (inSearchMode ? searchHasMore : browseHasMore)
              ? "Next page"
              : "End of results"
          }
        >
          Next →
        </button>
      </div>

      {/* Single-row tier slider. `flex-1 min-w-[5.5rem]` on each
          button means: when the strip has more space than the five
          mins combined (desktop / wide cards), the buttons share the
          extra width equally and the strip looks like a static
          5-column row; when the strip is narrower (cramped lobby on
          a small viewport / when the right column is squeezed by a
          long roster), the min-widths force overflow and ScrollStrip
          enables drag-to-pan. */}
      <ScrollStrip
        className="mt-4"
        gapClass="gap-1"
        ariaLabel="Difficulty picker"
      >
        {MODES.map((m) => (
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
      </ScrollStrip>

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
            <span>
              {allReady
                ? "EVERYONE IS READY. START MATCH"
                : "WAITING FOR PLAYERS. START ANYWAY"}
            </span>
            <span
              aria-hidden
              className="inline-block transition-transform duration-200 group-hover:translate-x-0.5"
            >
              ▶
            </span>
          </>
        )}
      </button>
    </div>
  );
}

/**
 * Host-only room editor. Display mode shows the title + visibility
 * pill + an "edit" affordance; edit mode swaps in a compact form with
 * a name input and a public/private toggle so both knobs land in one
 * dialog (was: rename-only, which made flipping visibility require
 * leaving + recreating the room).
 *
 * Save semantics mirror the server-side validators exactly: a blank
 * name keeps the previous name (we just don't emit) and the visibility
 * enum is locked to the two literal strings, so a stale client can't
 * smuggle a junk value through. We also fire the two events
 * conditionally — only when the value actually changed — to avoid
 * pointless snapshot churn for "open editor / press save without
 * touching anything".
 */
function RoomTitleEditor({
  name,
  visibility,
  onRename,
  onVisibility,
}: {
  name: string;
  visibility: "public" | "private";
  onRename: (next: string) => void;
  onVisibility: (next: "public" | "private") => void;
}) {
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [visDraft, setVisDraft] = useState<"public" | "private">(visibility);

  const beginEdit = useCallback(() => {
    setNameDraft(name);
    setVisDraft(visibility);
    setEditing(true);
  }, [name, visibility]);

  const commit = useCallback(() => {
    const trimmed = nameDraft.trim();
    if (trimmed && trimmed !== name) onRename(trimmed);
    if (visDraft !== visibility) onVisibility(visDraft);
    setEditing(false);
  }, [nameDraft, visDraft, name, visibility, onRename, onVisibility]);

  if (editing) {
    return (
      <div className="mt-1 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <input
            autoFocus
            value={nameDraft}
            onChange={(e) =>
              setNameDraft(e.target.value.slice(0, ROOM_NAME_MAX_LEN))
            }
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") setEditing(false);
            }}
            maxLength={ROOM_NAME_MAX_LEN}
            spellCheck={false}
            autoComplete="off"
            className="min-w-0 flex-1 border-2 border-bone-50/20 bg-transparent px-2 py-1 font-display text-[1.05rem] font-bold text-bone-50 outline-none focus:border-accent"
            aria-label="Room name"
          />
          <button
            onClick={commit}
            className="brut-btn-accent px-3 py-1 text-[0.79rem]"
          >
            save
          </button>
          <button
            onClick={() => setEditing(false)}
            className="font-mono text-[0.72rem] uppercase tracking-widest text-bone-50/55 hover:text-bone-50"
            data-tooltip="Discard changes"
          >
            cancel
          </button>
        </div>
        <VisibilityToggle value={visDraft} onChange={setVisDraft} />
      </div>
    );
  }

  return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      <h3 className="font-display text-[1.31rem] font-bold leading-tight">
        {name || "Room"}
      </h3>
      <VisibilityBadge visibility={visibility} />
      <button
        onClick={beginEdit}
        className="font-mono text-[0.72rem] uppercase tracking-widest text-bone-50/55 hover:text-accent"
        data-tooltip="Rename this room or change its visibility"
      >
        edit
      </button>
    </div>
  );
}

/**
 * Compact two-pill segmented control for the visibility choice. Lives
 * next to the room-name input in the editor so both knobs are visible
 * at once. Styling intentionally matches the create-pane visibility
 * picker so the two flows feel like the same control.
 */
function VisibilityToggle({
  value,
  onChange,
}: {
  value: "public" | "private";
  onChange: (next: "public" | "private") => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Room visibility"
      className="inline-flex w-full overflow-hidden border-2 border-bone-50/20"
    >
      <VisibilityToggleOption
        value="private"
        label="○ private"
        active={value === "private"}
        onSelect={onChange}
        title="Only people with the code can join"
      />
      <VisibilityToggleOption
        value="public"
        label="● public"
        active={value === "public"}
        onSelect={onChange}
        title="Anyone can find and join from the public browser"
      />
    </div>
  );
}

function VisibilityToggleOption({
  value,
  label,
  active,
  onSelect,
  title,
}: {
  value: "public" | "private";
  label: string;
  active: boolean;
  onSelect: (next: "public" | "private") => void;
  title: string;
}) {
  return (
    <button
      role="radio"
      aria-checked={active}
      onClick={() => onSelect(value)}
      data-tooltip={title}
      className={`flex-1 px-3 py-1.5 font-mono text-[10.5px] uppercase tracking-widest transition-colors ${
        active
          ? "bg-accent/15 text-accent"
          : "text-bone-50/60 hover:text-bone-50"
      }`}
    >
      {label}
    </button>
  );
}

function VisibilityBadge({
  visibility,
}: {
  visibility: "public" | "private";
}) {
  const isPublic = visibility === "public";
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 border-2 px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-widest ${
        isPublic
          ? "border-accent/70 text-accent"
          : "border-bone-50/30 text-bone-50/55"
      }`}
      data-tooltip={
        isPublic
          ? "Public — appears in the room browser"
          : "Private — only people with the code can join"
      }
    >
      {isPublic ? "● public" : "○ private"}
    </span>
  );
}

function firstAvailableMode(modes: ModeAvailability): ChartMode {
  for (const m of MODE_ORDER) {
    if (modes.available[m]) return m;
  }
  return "easy";
}

/**
 * `m:ss` formatter for catalog row track lengths. Mirrors
 * `formatDuration` in MultiGame.tsx / Game.tsx (kept local rather
 * than imported to avoid pulling Game.tsx into the lobby bundle).
 * Defensive about junk input — the catalog payload comes from a
 * 3rd-party search mirror, so any non-finite or negative number
 * collapses to `"0:00"` instead of throwing or rendering `"NaN:NaN"`.
 */
function formatTrackLength(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

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
  const available = !hasSelectedSong ? true : !!probe?.available[mode];
  const disabled = hasSelectedSong && (probing || !available);
  const enabled = !disabled;
  const reason = !hasSelectedSong
    ? undefined
    : probing
      ? "Reading the song's difficulty list…"
      : !available
        ? `Couldn't fit a ${displayMode(mode)} chart for this song's density profile.`
        : undefined;
  const stars = modeStars(mode);
  // Density tooltip mirrors the single-player picker — players asked
  // to see "X notes · Y nps" instead of the cosmetic intensity rating
  // (the tier name + ★ ramp are already rendered on the button).
  const noteCount = probe?.noteCounts[mode] ?? 0;
  const nps = probe?.npsByMode[mode] ?? 0;
  const densityTooltip = `${noteCount.toLocaleString()} notes · ${nps.toFixed(1)} nps`;
  return (
    <button
      onClick={() => enabled && onPick(mode)}
      disabled={disabled}
      data-tooltip={reason ?? densityTooltip}
      className={`flex flex-1 min-w-[5.5rem] flex-col items-center justify-center gap-0.5 px-2 py-1.5 font-mono text-[10.5px] uppercase tracking-widest border-2 transition-colors ${
        selected && available
          ? "border-accent bg-accent text-ink-900"
          : disabled
            ? probing
              ? "border-bone-50/30 text-bone-50/50 cursor-wait"
              : "border-dashed border-bone-50/20 text-bone-50/35 cursor-not-allowed"
            : "border-bone-50/30 text-bone-50/60 hover:border-bone-50/60"
      }`}
    >
      <span>{displayMode(mode)}</span>
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

/* ------------------------------------------------------------------------ */
/* Guest pane                                                               */
/* ------------------------------------------------------------------------ */

/* ------------------------------------------------------------------------ */
/* Match-in-progress pane (right column for late-joiners / leavers)         */
/* ------------------------------------------------------------------------ */

/**
 * Renders the right-column card while THIS client is sitting in the
 * lobby but the rest of the room is past the lobby phase (loading /
 * countdown / playing / results). Replaces both the host and guest
 * panes — see the dispatch in `Lobby` for the rationale.
 *
 * Layout:
 *   1. Header with "Match in progress" + a phase pill (loading /
 *      countdown / playing / results) so the watcher knows where
 *      the room currently is.
 *   2. Selected song row (artist — title) so the watcher can see
 *      what's being played without checking another panel.
 *   3. Song progress bar — only shown during the `playing` phase.
 *      Recomputed every 250ms via a local rAF-throttled tick state
 *      so the bar advances live; the parent snapshot only updates
 *      on score events (5Hz) and would otherwise miss the in-
 *      between frames. Hidden during loading / countdown /
 *      results because progress is undefined for those phases.
 *   4. Compact live scoreboard — top entries only; full scoreboard
 *      lives on the in-match HUD for participants. Host badge,
 *      "you" badge (if the watcher's own row appears, e.g. in the
 *      "leaver" case where they have a partial live score), and
 *      a small disconnect dot for offline players.
 *
 * Why no "Join match" CTA: the server doesn't expose a way for a
 * lobby watcher to jump into a half-played song. They wait for the
 * round to end and rejoin the next one automatically (the next
 * `transitionToLobby` resets `inMatch` for everyone, so they're
 * pulled back into the next match the moment the host presses
 * Start). Adding a CTA here would imply functionality we don't
 * actually offer.
 */
function MatchInProgressPane({
  snapshot,
  scoreboard,
}: {
  snapshot: RoomSnapshot;
  scoreboard: ScoreboardEntry[];
}) {
  const selected = snapshot.selectedSong;
  const phase = snapshot.phase;
  // Live wall-clock tick so the song progress bar advances between
  // 5Hz scoreboard snapshots. 250ms cadence (4Hz) is enough — the
  // bar is small and a quarter-second of jitter isn't visible at
  // the rendered width. Pause when the room is paused so the bar
  // freezes too (it would otherwise overshoot during a long pause
  // and jump back when the host resumes).
  const [, setNow] = useState(0);
  useEffect(() => {
    if (phase !== "playing") return;
    if (snapshot.pausedAt !== null) return;
    const id = setInterval(() => setNow((n) => n + 1), 250);
    return () => clearInterval(id);
  }, [phase, snapshot.pausedAt]);

  // Sort scoreboard locally too — the server already sorts by score
  // descending, but a snapshot tick that arrives before the next
  // scoreboard fan-out could leave entries out of order if the
  // upstream order shifts. Cheap enough at <50 entries.
  const sortedScoreboard = useMemo(
    () => [...scoreboard].sort((a, b) => b.score - a.score),
    [scoreboard],
  );
  const topScores = sortedScoreboard.slice(0, 8);

  // Song progress: 0..1 fraction of the song that's been played.
  // null when undefined (not in playing phase, or duration unknown).
  let progress: number | null = null;
  let elapsedSec = 0;
  let durationSec = 0;
  if (
    phase === "playing" &&
    snapshot.songStartedAt !== null &&
    selected?.durationSec
  ) {
    durationSec = selected.durationSec;
    const elapsedMs = snapshot.pausedAt !== null
      ? snapshot.pausedAt - snapshot.songStartedAt
      : Date.now() - snapshot.songStartedAt;
    elapsedSec = Math.max(0, Math.min(durationSec, elapsedMs / 1000));
    progress = durationSec > 0 ? elapsedSec / durationSec : 0;
  }

  return (
    <div className="brut-card flex h-full flex-col p-5 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[10.5px] uppercase tracking-[0.4em] text-accent">
            ░ Match in progress
          </p>
          <h3 className="mt-1 font-display text-[1.31rem] font-bold leading-tight">
            {snapshot.name || "Room"}
          </h3>
        </div>
        <PhasePill phase={phase} paused={snapshot.pausedAt !== null} />
      </div>

      {/* Currently-playing song. Mirrors the GuestPane "Currently
          selected" tile so a player who flips between the two views
          (round ends → lobby → next round starts) sees the same
          shape land in the same place. */}
      <div className="mt-4 border-2 border-bone-50/20 px-3 py-2">
        <p className="font-mono text-[10.5px] uppercase tracking-widest text-bone-50/50">
          Now playing
        </p>
        {selected ? (
          <p
            className="mt-0.5 truncate font-mono text-[0.92rem] text-bone-50/90"
            data-tooltip={`${selected.artist} — ${selected.title}`}
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
            (no song info)
          </p>
        )}
        {progress !== null && (
          <div className="mt-2 space-y-1">
            <div className="relative h-1 border border-bone-50/15 bg-transparent">
              <div
                className="h-full bg-accent transition-all duration-200 ease-out"
                style={{ width: `${Math.min(100, progress * 100)}%` }}
              />
            </div>
            <p className="text-right font-mono text-[9.5px] uppercase tracking-widest tabular-nums text-bone-50/50">
              {formatTrackLength(elapsedSec)} / {formatTrackLength(durationSec)}
            </p>
          </div>
        )}
      </div>

      {/* Compact live scoreboard. Shown for every match phase, even
          loading / countdown — entries will all be 0 until songs
          start, but rendering the empty rows keeps the panel from
          shifting layout the moment the first score lands. Grows
          with the player count and lets the page scrollbar on the
          right edge take overflow — no mid-card inner scrollbar. */}
      <div className="mt-4 min-h-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <p className="font-mono text-[10.5px] uppercase tracking-widest text-bone-50/50">
            Live scoreboard
          </p>
          <span className="font-mono text-[9.5px] uppercase tracking-widest text-bone-50/40">
            {sortedScoreboard.length} player{sortedScoreboard.length === 1 ? "" : "s"}
          </span>
        </div>
        <ul className="mt-2 space-y-1 border-2 border-bone-50/10 p-1">
          {topScores.length === 0 && (
            <li className="px-3 py-2 font-mono text-[0.79rem] text-bone-50/40">
              waiting for the first scores…
            </li>
          )}
          {topScores.map((entry, idx) => (
            <li
              key={entry.id}
              className={`flex items-center gap-2 border border-bone-50/10 px-2.5 py-1.5 ${
                idx === 0 ? "bg-accent/10" : ""
              }`}
            >
              <span
                className="w-5 shrink-0 text-right font-mono text-[10.5px] uppercase tracking-widest tabular-nums text-bone-50/45"
                aria-hidden
              >
                {idx + 1}
              </span>
              <span
                className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                  entry.online ? (entry.finished ? "bg-bone-50/40" : "bg-accent") : "bg-bone-50/30"
                }`}
                data-tooltip={
                  entry.online
                    ? entry.finished
                      ? "Finished the song"
                      : "Live"
                    : "Disconnected"
                }
              />
              <span className="min-w-0 flex-1 truncate font-mono text-[0.86rem] text-bone-50/85">
                {entry.name || "—"}
              </span>
              <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-bone-50/55">
                {entry.accuracy.toFixed(1)}%
              </span>
              <span className="w-20 shrink-0 text-right font-mono text-[0.86rem] tabular-nums text-bone-50">
                {entry.score.toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <p className="mt-4 font-mono text-[10.5px] uppercase tracking-widest text-bone-50/45">
        You&apos;ll re-join automatically when the host starts the next round
      </p>
    </div>
  );
}

/**
 * Tiny phase pill rendered next to the room name in the
 * match-in-progress pane. Mirrors the visibility badge styling so
 * the row reads as one cluster of metadata.
 */
function PhasePill({
  phase,
  paused,
}: {
  phase: RoomSnapshot["phase"];
  paused: boolean;
}) {
  const label = paused
    ? "paused"
    : phase === "loading"
      ? "loading"
      : phase === "countdown"
        ? "countdown"
        : phase === "playing"
          ? "playing"
          : phase === "results"
            ? "results"
            : "lobby";
  const accent = phase === "playing" && !paused;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 border-2 px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-widest ${
        accent
          ? "border-accent/70 text-accent"
          : "border-bone-50/30 text-bone-50/65"
      }`}
      data-tooltip="Current room phase"
    >
      ● {label}
    </span>
  );
}

function GuestPane({ snapshot }: { snapshot: RoomSnapshot }) {
  const selected = snapshot.selectedSong;
  return (
    <div className="brut-card flex h-full flex-col items-start gap-4 p-5 sm:p-6">
      <div>
        <p className="font-mono text-[10.5px] uppercase tracking-[0.4em] text-accent">
          ░ Waiting for host
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <h3 className="font-display text-[1.31rem] font-bold">
            {snapshot.name || "Room"}
          </h3>
          <VisibilityBadge visibility={snapshot.visibility} />
        </div>
        <p className="mt-2 max-w-md text-[0.92rem] text-bone-50/65">
          The host of this room chooses the song and difficulty. Hit{" "}
          <span className="font-mono text-bone-50">Mark ready</span> to
          tell the host you&apos;re good to go.
        </p>
      </div>

      <div className="w-full border-2 border-bone-50/20 px-3 py-2">
        <p className="font-mono text-[10.5px] uppercase tracking-widest text-bone-50/50">
          Currently selected
        </p>
        {selected ? (
          <p
            className="mt-0.5 truncate font-mono text-[0.92rem] text-bone-50/90"
            data-tooltip={`${selected.artist} — ${selected.title}`}
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
