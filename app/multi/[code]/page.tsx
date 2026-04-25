"use client";

/**
 * The live multiplayer room. Owns the socket for the duration of the page
 * and routes between phase-specific UI:
 *
 *   lobby     → <Lobby> (player list, host song picker, start button)
 *   loading   → <LoadingScreen> (download + decode the host's pick, send "ready")
 *   countdown → <MultiGame> (already showing the highway with countdown overlay)
 *   playing   → <MultiGame> (canvas + sidebar scoreboard)
 *   results   → <ResultsScreen> (final standings, keep playing / leave)
 *
 * If the URL is hit cold (no sessionStorage entry for this code) we bounce
 * back to `/multi?code=XXXXXX`, which auto-selects the Join tab and
 * pre-fills the code. Centralising the "name + code" form there means
 * the room page only ever renders for users who actually have a seat
 * (or are mid-rejoin), and there's no risk of a stale "join with name"
 * card appearing after someone leaves the room and presses back.
 */

import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { HomeButton } from "@/components/HomeButton";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ArrowIcon } from "@/components/icons/ArrowIcon";
import { InGameChatWidget } from "@/components/multi/InGameChatWidget";
import { Lobby } from "@/components/multi/Lobby";
import { LoadingScreen } from "@/components/multi/LoadingScreen";
import PrestartOverlay from "@/components/multi/PrestartOverlay";
import { MultiGame } from "@/components/multi/MultiGame";
import { ResultsScreen } from "@/components/multi/ResultsScreen";
import { useRoomSocket } from "@/hooks/useRoomSocket";
import {
  useAttemptLeave,
  useLeaveGuard,
} from "@/components/LeaveGuardProvider";
import { isValidRoomCode } from "@/lib/multi/protocol";
import type { LoadSongResult, ChartMode } from "@/lib/game/chart";
import { loadSongById } from "@/lib/game/chart";
import { AudioEngine } from "@/lib/game/audio";

export default function MultiRoomPage() {
  const params = useParams();
  const router = useRouter();
  const rawCode = (Array.isArray(params?.code) ? params.code[0] : params?.code) ?? "";
  const code = String(rawCode).toUpperCase();
  const valid = isValidRoomCode(code);

  const {
    conn,
    sessionId,
    snapshot,
    scoreboard,
    notices,
    results,
    chat,
    selectedMode,
    loadDeadline,
    lastError,
    kicked,
    clearError,
    actions,
  } = useRoomSocket(valid ? code : null);

  // Hard kick: redirect home with a one-shot toast. Sets a flag in
  // sessionStorage so the homepage can render the "you got kicked"
  // splash (handled by the homepage; if absent the user just lands
  // home and the flag self-clears).
  useEffect(() => {
    if (!kicked) return;
    try {
      sessionStorage.setItem(
        "syncle.kicked.notice",
        kicked.reason || "You were kicked",
      );
    } catch {
      /* ignore */
    }
    actions.leave();
    // router.replace so the kicked /multi/[code] URL is removed
    // from history rather than leaving it as a back-press trap
    // (re-mounting it would just bounce the kicked player back to
    // /multi via the cold-hit redirect, which is wasteful).
    router.replace("/multi");
  }, [kicked, actions, router]);

  // Tracks whether the user already has a session for THIS room cached in
  // sessionStorage - set when they came in via Create or Join from the
  // /multi entry page (which writes the sessionId before navigating).
  // While true, `useRoomSocket` auto-rejoins on connect and the snapshot
  // lands a beat later - we just show the "joining…" connecting card in
  // the meantime. If false (cold URL hit, or back-navigation after a
  // leave cleared the session) we kick the user back to `/multi` instead
  // of rendering a redundant inline join form here. If the auto-rejoin
  // fails (room expired / kicked from server side) the hook clears the
  // stored session and surfaces a `lastError`; the effect below re-reads
  // storage on each error so the redirect path can engage.
  const [hasStoredSession, setHasStoredSession] = useState<boolean>(() => {
    if (typeof window === "undefined" || !valid) return false;
    try {
      return !!window.sessionStorage.getItem(`syncle.session.${code}`);
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (typeof window === "undefined" || !valid) return;
    try {
      setHasStoredSession(
        !!window.sessionStorage.getItem(`syncle.session.${code}`),
      );
    } catch {
      setHasStoredSession(false);
    }
  }, [lastError, sessionId, code, valid]);

  // We "have a seat" once the server has sent us a snapshot containing our
  // sessionId. Otherwise we either (a) are mid-rejoin and waiting, or
  // (b) hit the URL cold and are about to be redirected to /multi.
  const me = useMemo(() => {
    if (!snapshot || !sessionId) return null;
    return snapshot.players.find((p) => p.id === sessionId) ?? null;
  }, [snapshot, sessionId]);

  // Leave guard: prompt the user before they accidentally drop out
  // of the room. Active any time we have a confirmed seat AND we
  // haven't already been kicked (kick is involuntary - surfacing a
  // "stay?" prompt to a kicked player would just be confusing).
  // Covers tab close / refresh (browser-native dialog), browser
  // back button (popstate sentinel), and in-page Back / Home /
  // anchor clicks (intercepted via `attemptLeave`).
  //
  // We branch on whether the player is currently IN A MATCH (not
  // just sitting in the lobby): leaving from inside a match drops
  // them back into the lobby of the SAME room - same end-state as
  // the in-game match menu's "Leave" / "Cancel match" - instead of
  // yanking them all the way back to /multi. The intuition is that
  // "Back" mid-round means "abandon this round", not "abandon the
  // whole party". Only Back from the lobby itself fully exits the
  // room (router.replace to /multi).
  //
  // Phases covered as "in match":
  //   - loading   → mid-download. Back drops to lobby (the round is
  //                 effectively never started for this client).
  //   - countdown → mid 3-2-1. Back drops to lobby.
  //   - playing   → mid-song. Back drops to lobby.
  //   - results   → NOT covered. The match is over; the results
  //                 screen has its own "Back to lobby" CTA, and
  //                 leaveMatch / cancelMatch both no-op server-side
  //                 in this phase. Back from results behaves like
  //                 Back from lobby (full leave).
  //
  // Host vs non-host:
  //   - Non-host fires `room:leaveMatch`, which flips just THIS
  //     player's `inMatch` to false on the server and re-renders
  //     them into the lobby UI on the next snapshot. Other players
  //     keep playing.
  //   - Host fires `host:cancelMatch`, which transitions the WHOLE
  //     room back to lobby. The host has no equivalent of
  //     "drop-out-but-keep-the-round-running" - they own the round.
  //     This mirrors the in-match menu where the host's only
  //     escape is the "Cancel match" button.
  //
  // `defaultLeave` (browser back button) and the in-page Back
  // button both call `handleConfirmedLeave` so the two paths are
  // guaranteed identical - no risk of one diverging from the other
  // (which is what the previous Back-button impl had: it always
  // ran the full-leave path regardless of phase, contradicting the
  // browser-back guard right next to it).
  const attemptLeave = useAttemptLeave();
  const guardActive = me !== null && !kicked;
  const inActiveMatch = !!(
    me?.inMatch &&
    (snapshot?.phase === "loading" ||
      snapshot?.phase === "countdown" ||
      snapshot?.phase === "playing")
  );
  const isHost = !!me?.isHost;
  const handleConfirmedLeave = useCallback(() => {
    if (inActiveMatch) {
      if (isHost) {
        // Host's "drop me back to lobby" = cancel for everyone.
        // Server's transitionToLobby flips inMatch false for all
        // players and the next snapshot routes them to the Lobby UI.
        actions.cancelMatch();
      } else {
        // Server flips `me.inMatch` to false on receipt; the next
        // snapshot tick routes this client to the lobby UI (see
        // RoomBody's per-player phase routing). No URL change -
        // the rest of the room keeps playing.
        actions.leaveMatch();
      }
      return;
    }
    // Lobby (or results - see phase notes above): full room leave.
    actions.leave();
    // router.replace (not push) so the LeaveGuardProvider can
    // collapse the guarded /multi/[code] entry out of history
    // - see its sentinel-pop logic. Pressing browser back from
    // /multi after this lands the user at whatever they were
    // doing BEFORE joining the room. (Even if it didn't, the
    // cold-hit redirect on /multi/[code] would now bounce the
    // user back to /multi instead of resurrecting a stale form.)
    router.replace("/multi");
  }, [inActiveMatch, isHost, actions, router]);
  useLeaveGuard({
    enabled: guardActive,
    // Messages are intentionally destination-agnostic ("leaving
    // will…", not "going back to the lobby will…") because this
    // SAME guard fires for both:
    //   - Back / browser-back → drops to the room's own lobby
    //     (handled by `handleConfirmedLeave`)
    //   - HomeButton in the same header → fully exits the room
    //     and navigates home
    // Promising a specific destination in the modal would be
    // wrong half the time. The user always knows which trigger
    // they clicked, so "leaving will <consequence>" is enough
    // context.
    message: inActiveMatch
      ? isHost
        ? "There's a match in progress - leaving will cancel it for everyone."
        : "There's a match in progress - leaving will drop you out of this round."
      : "You'll leave the room and lose your seat at the table.",
    defaultLeave: handleConfirmedLeave,
  });

  // ---- chart loading (triggered by phase:loading) -----------------------
  const [loadedChart, setLoadedChart] = useState<LoadSongResult | null>(null);
  const [loadProgress, setLoadProgress] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const lastLoadedKeyRef = useRef<string | null>(null);

  // Page-level AudioEngine.
  //
  // Hoisted up here (instead of living inside <MultiGame>) so we can
  // decode the song's AudioBuffer DURING the `loading` phase - i.e.
  // alongside the .osz download - instead of after the player has
  // already advanced into `countdown` and the engine is being created
  // for the first time. The previous topology meant the decode (~100–
  // 500ms for a 3min mp3 / ogg) raced against the visible "3 / 2 / 1"
  // overlay; on slow machines the schedule effect would sit waiting
  // on `audioReady` for a beat or two and the playhead would catch
  // up via the late-join seek path. With the hoist, decode happens
  // while everyone's already staring at the loading screen, so by
  // the time `MultiGame` mounts the AudioBuffer is already in memory
  // and `audio.start()` is just reserving a future timestamp on a
  // pre-warmed graph. No race, no seek-fallback, no risk of the
  // first frame of a song being a 1-frame catch-up.
  //
  // Engine lifecycle:
  //   - Created lazily on the FIRST song load (loading effect below).
  //   - Reused across rounds in the same room - `loadFromBytes()`
  //     dedups via its `key` arg AND replaces the buffer in-place,
  //     so the AudioContext + master/SFX graph survives every round
  //     change.
  //   - Stopped (but not destroyed) when we go back to lobby. Stopped
  //     AND closed implicitly when the page unmounts (the engine ref
  //     is dropped; AudioContext gets GC'd).
  //
  // Why an `AudioEngine | null` ref + a boolean state instead of just
  // a state: the engine itself is a heavy mutable object, and React
  // would treat every internal mutation as a state change if we
  // tried to put it in `useState`. The boolean is what consumers
  // (MultiGame's schedule effect) actually depend on.
  const audioEngineRef = useRef<AudioEngine | null>(null);
  const [audioReady, setAudioReady] = useState<boolean>(false);

  // Tracks the song key the in-flight chart download / decode is for.
  // We DON'T tie cancellation to effect lifecycle (a `let cancelled`
  // captured in closure), because the loading effect re-runs on every
  // phase tick - so a slow loader whose room flips from `loading` →
  // `countdown` while their download is in flight would have their
  // promise short-circuited by the cleanup, yet `lastLoadedKeyRef`
  // would still point at the same key and the new effect run would
  // early-return. Result: the player gets stuck on "Decoding audio…"
  // forever. With a key-keyed inflight ref, the in-flight promise
  // checks `inflightLoadKeyRef.current === key` on resolve - phase
  // changes don't disturb it; only a real song change supersedes it.
  // The mounted ref handles the page-unmount safety (don't setState
  // after unmount).
  const inflightLoadKeyRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // When the snapshot says "loading" with a selected song, kick off the
  // download. We dedup by `${beatmapsetId}:${mode}` so we don't re-download
  // when the snapshot ticks for unrelated reasons (player joined, name
  // changed, etc).
  //
  // We ALSO trigger this in countdown / playing phases when we don't yet
  // have a chart loaded - that's the reconnect case. If a player drops
  // mid-game and the socket re-establishes after the room has already
  // moved past `loading`, the snapshot they receive on rejoin will be
  // in `countdown` or `playing` and the loading effect would otherwise
  // never fire - leaving the highway stuck on "Waiting for chart…"
  // forever. Re-fetching here (deduped by `lastLoadedKeyRef`) lets the
  // returning player catch back up to the same song the room is on.
  useEffect(() => {
    if (!snapshot) return;
    const song = snapshot.selectedSong;
    if (!song) return;
    // Late-joiners and leavers (`me.inMatch === false`) sit in the
    // lobby with a "match in progress" indicator and never run the
    // chart locally - skip the heavy download / decode pipeline for
    // them. They'll get the chart on the next round when the host
    // pulls everyone back into a fresh match.
    if (!me?.inMatch) return;
    const phase = snapshot.phase;
    const isLoadingPhase = phase === "loading";
    // Reconnect-during-play recovery: same song selection, no local chart
    // yet, and the room is past the lobby. Skip if we already loaded
    // (lastLoadedKeyRef matches) so we don't refetch for harmless
    // snapshot ticks like another player joining or being renamed.
    const isReconnectRecovery =
      (phase === "countdown" || phase === "playing") && loadedChart === null;
    if (!isLoadingPhase && !isReconnectRecovery) return;

    // The host's chosen difficulty is communicated via the `phase:loading`
    // event (kept off the snapshot to avoid renegotiating mid-play). If we
    // somehow missed the event (joined right at phase change, or the
    // socket reconnected past the loading phase), fall back to "easy" -
    // the server will still gate hits + the load works regardless.
    const targetMode: ChartMode = selectedMode ?? "easy";

    const key = `${song.beatmapsetId}:${targetMode}`;
    if (lastLoadedKeyRef.current === key) return;
    lastLoadedKeyRef.current = key;
    inflightLoadKeyRef.current = key;

    // `stillCurrent()` is the cancellation predicate. It's true while
    // (a) the page is still mounted AND (b) the in-flight load is
    // still for THIS song key. Phase changes don't flip either of
    // these, so a slow loader whose room moves on to `countdown` /
    // `playing` mid-download keeps grinding and resolves cleanly into
    // the late-join recovery path (their MultiGame mounts; the
    // schedule effect sees `startsAt` is in the past and seeks the
    // audio buffer by `now - startsAt` so they slot into the song
    // timeline at the right offset).
    const stillCurrent = () =>
      mountedRef.current && inflightLoadKeyRef.current === key;

    setLoadedChart(null);
    setAudioReady(false);
    setLoadProgress(`Downloading ${song.artist} - ${song.title}…`);
    setLoadError(null);

    // Two-stage prep: download + parse the chart, THEN decode the audio
    // bytes into the (page-level) AudioEngine. Both stages run before
    // we report `markReady()` so the server only advances past `loading`
    // once every player has the AudioBuffer actually in memory - no
    // "decoded during countdown" race, no first-frame catch-up via the
    // seek-fallback path. The progress label is updated between stages
    // so the LoadingScreen shows what we're actually doing.
    loadSongById(song.beatmapsetId, targetMode, {
      onProgress: (msg) => {
        if (stillCurrent()) setLoadProgress(msg);
      },
    })
      .then(async (res) => {
        if (!stillCurrent()) return res;
        setLoadedChart(res);
        setLoadProgress("Decoding audio…");

        // Stand the engine up on first need. Reused across rounds -
        // `loadFromBytes()` swaps the buffer in-place, so the
        // AudioContext + master / SFX graph carries over.
        if (!audioEngineRef.current) {
          audioEngineRef.current = new AudioEngine();
        }
        const engine = audioEngineRef.current;
        // `ensureContext()` is best-effort; the AudioContext might
        // start suspended if the browser hasn't seen a user gesture
        // for this tab yet (rare in practice - players reach loading
        // by clicking READY or START). Decode works fine on a
        // suspended context, and `audio.start()` resumes it later.
        try {
          engine.ensureContext();
        } catch {
          /* will recover when start() is called */
        }

        try {
          if (res.delivery === "remote" && res.audioBytes && res.audioKey) {
            // `decodeAudioData` detaches its input - slice so the
            // original bytes live on in `loadedChart` for any future
            // re-use (e.g. a "play again" round in the same room
            // that re-fires this effect with the same key, which
            // dedups via the loadedUrl/key check inside the engine).
            await engine.loadFromBytes(res.audioBytes.slice(0), res.audioKey);
          } else if (res.meta.audioUrl) {
            await engine.load(res.meta.audioUrl);
          }
        } catch {
          // Decode failed - surface it as a load error so the host
          // can see and retry, same path as a chart-fetch failure.
          if (stillCurrent()) {
            setLoadError("Failed to decode audio");
            // Re-check phase at resolution time (not the captured
            // `isLoadingPhase` from when the load started): a slow
            // loader's room may have already moved past `loading`,
            // in which case the server would ignore the failure
            // report anyway and the player will catch up via the
            // late-join path.
            if (snapshot?.phase === "loading") {
              actions.reportLoadFailure("Failed to decode audio");
            }
          }
          return res;
        }

        if (!stillCurrent()) return res;
        setAudioReady(true);
        setLoadProgress(null);
        // Only flag ourselves as `ready` to the server when the room
        // is STILL gating on us in the `loading` phase. On
        // reconnect-into-play AND on the slow-loader-late-join path
        // the server has already advanced past the gate, so a stray
        // `client:ready` would be ignored at best, churn state at
        // worst - we just want the local chart + audio populated so
        // the canvas can render and the schedule effect can seek.
        if (snapshot?.phase === "loading") actions.markReady();
        return res;
      })
      .catch((err) => {
        if (!stillCurrent()) return;
        const msg = err?.message ?? "Failed to load song";
        setLoadError(msg);
        if (snapshot?.phase === "loading") actions.reportLoadFailure(msg);
      });
    // No cleanup: cancellation is keyed by song, not effect lifecycle,
    // so phase / loadedChart re-runs of this effect don't disturb the
    // in-flight load. The next song change will bump
    // `inflightLoadKeyRef.current` and supersede us cleanly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    snapshot?.phase,
    snapshot?.selectedSong?.beatmapsetId,
    selectedMode,
    loadedChart,
    me?.inMatch,
  ]);

  // Reset the chart when we go back to lobby so a fresh round can re-trigger
  // the loading effect for the same song (same key) without thinking it was
  // already done. Also tears down any in-flight audio so the next round
  // starts from silence - the engine itself is kept alive (its
  // AudioContext + graph are reused) but the playing source is stopped.
  useEffect(() => {
    if (snapshot?.phase === "lobby") {
      lastLoadedKeyRef.current = null;
      inflightLoadKeyRef.current = null;
      setLoadedChart(null);
      setLoadProgress(null);
      setLoadError(null);
      setAudioReady(false);
      audioEngineRef.current?.stop();
    }
  }, [snapshot?.phase]);

  // Per-player audio gate: if THIS client just left the match (the
  // server flipped `me.inMatch` to false in response to `room:leaveMatch`,
  // or this is a late joiner), MultiGame is about to unmount. Without
  // this effect the page-level AudioEngine would keep its source node
  // playing - the player would hear the song they "left" continue in
  // the background while sitting in the lobby UI. Stopping the engine
  // here cuts the audio cleanly. We also reset the chart cache so a
  // future "rejoin match" path (or a new round starting) re-runs the
  // download + decode from scratch instead of resuming a stale buffer
  // at a bogus offset.
  useEffect(() => {
    const phase = snapshot?.phase;
    if (
      phase !== "loading" &&
      phase !== "countdown" &&
      phase !== "playing"
    ) {
      return;
    }
    if (me?.inMatch) return;
    audioEngineRef.current?.stop();
    lastLoadedKeyRef.current = null;
    inflightLoadKeyRef.current = null;
    setLoadedChart(null);
    setLoadProgress(null);
    setLoadError(null);
    setAudioReady(false);
  }, [me?.inMatch, snapshot?.phase]);

  // Stop the engine when the page itself unmounts (player navigated
  // away, leave-room, etc). Dropping the ref is enough for the
  // AudioContext to be GC'd; we also call `stop()` so any currently-
  // playing source releases immediately rather than running until its
  // scheduled end while the user is already on a different page.
  useEffect(() => {
    return () => {
      audioEngineRef.current?.stop();
      audioEngineRef.current = null;
    };
  }, []);

  if (!valid) {
    return <InvalidCodeScreen code={String(rawCode)} onBack={() => router.push("/multi")} />;
  }

  // Cold URL hit: connected to the server, no seat in the room, AND no
  // stored session for this code. Bounce to `/multi?code=XXXXXX` so the
  // entry page can present the proper Join tab (with the code prefilled
  // and the saved display name restored from localStorage). This avoids
  // duplicating the join form here and removes the awkward "join with
  // name" card that would otherwise appear if a player pressed back
  // after leaving the lobby (which clears their stored session).
  const needsJoin = conn === "connected" && !me && !hasStoredSession;
  useEffect(() => {
    if (!needsJoin) return;
    router.replace(`/multi?code=${encodeURIComponent(code)}`);
  }, [needsJoin, router, code]);

  // Gameplay phases need to break out of the page's max-width container so
  // the canvas can fill the whole viewport (minus the header), matching the
  // single-player experience. Lobby / loading / results stay in the
  // constrained card layout because they're form-style screens.
  //
  // Per-player routing: `me.inMatch` gates whether THIS client is in the
  // match UI or sitting in the lobby with a "match in progress" indicator.
  // Late-joiners (`inMatch=false` set by the server in `joinRoom` when the
  // room is past the lobby) and players who used the in-match menu's
  // "Leave" button fall into the lobby branch even when the room phase is
  // `playing`. RoomBody's switch mirrors this - it routes to the Lobby
  // component for non-participants regardless of `snapshot.phase`.
  const inGame =
    me &&
    snapshot &&
    me.inMatch &&
    (snapshot.phase === "countdown" || snapshot.phase === "playing");

  return (
    <main className="relative flex h-screen w-screen flex-col overflow-hidden">
      {/* Padding kept in lockstep with the homepage / /play / /multi
          headers (px-4 sm:px-6 py-3) so the 38×38 icon-btn row
          produces the same overall header height on every page. */}
      <header className="relative z-20 flex items-center justify-between gap-3 border-b-2 border-bone-50/15 px-4 py-3 sm:px-6">
        <button
          onClick={() => {
            // Routed through the global leave-guard so an active
            // seat surfaces the confirm prompt before the action
            // runs. Pass-through when no guard is active (joining
            // / connecting screens).
            //
            // The proceed callback is `handleConfirmedLeave` - the
            // same function the browser-back guard uses - so Back-
            // button clicks and browser-back presses produce the
            // SAME behavior:
            //   - mid-loading / mid-countdown / mid-playing →
            //     drop this client (or for host, the whole room)
            //     back to the room's own lobby. We do NOT exit
            //     the room.
            //   - lobby / results → full leave + redirect to
            //     /multi.
            // Previously this onClick always called the full-leave
            // path regardless of phase, which contradicted the
            // browser-back guard right next to it (popstate would
            // drop you to the lobby; clicking the Back button
            // would yank you out of the room entirely). Routing
            // both through one callback keeps the two in lockstep.
            attemptLeave(handleConfirmedLeave);
          }}
          className="group inline-flex items-center gap-2 font-mono text-[11.5px] uppercase tracking-widest text-bone-50/70 hover:text-accent transition-colors"
        >
          <ArrowIcon
            direction="left"
            size={14}
            strokeWidth={2.75}
            className="transition-transform duration-200 group-hover:-translate-x-0.5"
          />
          <span>Back</span>
        </button>
        {/* Center cluster: room code + connection state. The ConnectionPill
            label collapses to a dot-only badge on <sm so the row fits
            alongside the back button + theme toggle on a 320px viewport
            without the room code wrapping or being squeezed. Tracking on
            the code chip is also tightened slightly on mobile. */}
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <code className="shrink-0 border-2 border-bone-50/30 px-1.5 py-0.5 font-mono text-[10.5px] tracking-[0.25em] text-bone-50/85 sm:px-2 sm:py-1 sm:text-[11.5px] sm:tracking-[0.4em]">
            {code}
          </code>
          <ConnectionPill conn={conn} />
        </div>
        <div className="flex items-center gap-2 sm:gap-3">
          {/* Leave the room cleanly before navigating home, otherwise
              the socket lingers and the player still appears in the
              roster to other clients for the connection-grace window. */}
          <HomeButton onNavigate={() => actions.leave()} />
          <ThemeToggle />
        </div>
      </header>

      <NoticeStack notices={notices} />

      {inGame ? (
        // Full-bleed game area: canvas fills the rest of the viewport
        // (header + this flex-1 region = 100vh). MultiGame draws its own
        // overlays (score/combo top-left, scoreboard right) on top.
        // The InGameChatWidget sits above as a sibling so it can float
        // in the bottom-right without participating in the canvas
        // layout.
        <div className="relative z-10 min-h-0 flex-1">
          {me && snapshot && (
            <RoomBody
              code={code}
              snapshot={snapshot}
              scoreboard={scoreboard}
              results={results}
              chat={chat}
              me={me.id}
              isHost={me.isHost}
              actions={actions}
              loadedChart={loadedChart}
              loadProgress={loadProgress}
              loadError={loadError}
              loadDeadline={loadDeadline}
              selectedMode={selectedMode}
              audioEngine={audioEngineRef.current}
              audioReady={audioReady}
            />
          )}
          {me && (
            <InGameChatWidget
              chat={chat}
              meId={me.id}
              meIsMuted={!!me.muted}
              actions={actions}
            />
          )}
        </div>
      ) : (
        // Two-layer wrapper so the page scrollbar lives at the
        // VIEWPORT edge instead of the inner content's right edge:
        //   - Outer: full-width container (z-10, flex-1). On
        //     mobile / tablet it's `overflow-y-auto` so long
        //     content scrolls the page naturally - the columns
        //     stack and a phone's viewport can't fit the whole
        //     lobby anyway. On `lg+` it flips to `overflow-hidden`:
        //     the lobby is sized to fit the viewport exactly and
        //     each card carries its own internal scroller (roster,
        //     catalog, chat). No page-level scrollbar on desktop -
        //     same feel as a typical productivity app.
        //   - Inner: centered, max-w-7xl. On `lg+` it's a flex
        //     column with `h-full` so child screens (the lobby
        //     grid in particular) can use `lg:h-full` to fill the
        //     available vertical space.
        // Putting overflow-y-auto on the centered max-w-7xl box
        // (as we did before) made the scrollbar sit at the right
        // edge of the centered box - visibly inset on wide
        // monitors - instead of flush against the viewport like
        // every normal website does it.
        <div className="relative z-10 flex-1 overflow-y-auto lg:flex lg:flex-col lg:overflow-hidden">
          <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 pt-6 pb-12 sm:px-6 lg:h-full lg:min-h-0 lg:flex-1 lg:pb-6">
            {/* Connecting card covers three cases:
                  1. socket isn't connected yet (initial handshake / reconnecting),
                  2. socket IS connected and we have a stored session for this
                     room, so the hook is mid-rejoin - show "joining" UI rather
                     than a blank page,
                  3. cold URL hit (`needsJoin` true) - the redirect effect
                     above bounces us to /multi?code=…; this card paints
                     for the single tick before the navigation lands. */}
            {!me && <ConnectingCard conn={conn} />}

            {me && snapshot && (
              <RoomBody
                code={code}
                snapshot={snapshot}
                scoreboard={scoreboard}
                results={results}
                chat={chat}
                me={me.id}
                isHost={me.isHost}
                actions={actions}
                loadedChart={loadedChart}
                loadProgress={loadProgress}
                loadError={loadError}
                loadDeadline={loadDeadline}
                selectedMode={selectedMode}
                audioEngine={audioEngineRef.current}
                audioReady={audioReady}
              />
            )}

            {lastError && (
              // Width-locked to the ConnectingCard above so the error
              // banner reads as a sibling of that card instead of a
              // full-bleed strip across the page. Both surfaces use
              // `mx-auto w-full max-w-md` - keep them in lockstep here.
              <div className="brut-card-accent mx-auto flex w-full max-w-md items-start justify-between gap-3 p-3">
                <p className="font-mono text-[0.79rem]">
                  <span className="text-rose-400">[{lastError.code}]</span>{" "}
                  {lastError.message}
                </p>
                <button onClick={clearError} className="font-mono text-[10.5px] uppercase tracking-widest text-bone-50/70 hover:text-accent">
                  dismiss
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}

/* ---------------------------------------------------------------------- */
/* Body                                                                   */
/* ---------------------------------------------------------------------- */

import type { ChatMessage, RoomSnapshot, ScoreboardEntry } from "@/lib/multi/protocol";
import type { ResultsPayload, RoomActions } from "@/hooks/useRoomSocket";

function RoomBody({
  code,
  snapshot,
  scoreboard,
  results,
  chat,
  me,
  isHost,
  actions,
  loadedChart,
  loadProgress,
  loadError,
  loadDeadline,
  selectedMode,
  audioEngine,
  audioReady,
}: {
  code: string;
  snapshot: RoomSnapshot;
  scoreboard: ScoreboardEntry[];
  results: ResultsPayload | null;
  chat: ChatMessage[];
  me: string;
  isHost: boolean;
  actions: RoomActions;
  loadedChart: LoadSongResult | null;
  loadProgress: string | null;
  loadError: string | null;
  loadDeadline: number | null;
  selectedMode: ChartMode | null;
  // Threaded down from the page so the in-game canvas reuses the
  // SAME engine that decoded the audio during the loading screen.
  // See `audioEngineRef` declaration in `MultiRoomPage` for rationale.
  audioEngine: AudioEngine | null;
  audioReady: boolean;
}) {
  // Wrap each phase in a fade-in shell so transitions from one phase
  // to another don't pop. The shell uses Tailwind's `animate-fade-in`
  // (defined in globals.css) which is a 220ms opacity ramp - enough
  // to feel intentional without slowing anyone down. The `key`
  // attribute on the wrapper is the phase name so React fully unmounts
  // / re-mounts on phase change, re-firing the animation.
  // Per-player routing: late-joiners + leavers (`inMatch=false`) are
  // routed to the Lobby for the entire duration of the match -
  // regardless of whether the room phase is `loading`, `countdown`,
  // `playing`, or `results`. The Lobby component picks up the
  // match-in-progress state from `snapshot.phase` + the live
  // scoreboard and renders a compact match-watcher view. Only
  // `inMatch=true` players see the LoadingScreen / MultiGame /
  // ResultsScreen below.
  const meSnapshot = snapshot.players.find((p) => p.id === me);
  const inMatch = !!meSnapshot?.inMatch;
  const inner = (() => {
    if (snapshot.phase !== "lobby" && !inMatch) {
      return (
        <Lobby
          code={code}
          snapshot={snapshot}
          scoreboard={scoreboard}
          meId={me}
          isHost={isHost}
          chat={chat}
          actions={actions}
        />
      );
    }
    switch (snapshot.phase) {
      case "lobby":
        return (
          <Lobby
            code={code}
            snapshot={snapshot}
            scoreboard={scoreboard}
            meId={me}
            isHost={isHost}
            chat={chat}
            actions={actions}
          />
        );
      case "loading":
        return (
          <LoadingScreen
            snapshot={snapshot}
            chat={chat}
            meId={me}
            progress={loadProgress}
            error={loadError}
            isHost={isHost}
            mode={selectedMode}
            deadline={loadDeadline}
            onCancel={actions.cancelLoading}
            actions={actions}
          />
        );
      case "countdown":
      case "playing":
        return (
          <MultiGame
            snapshot={snapshot}
            scoreboard={scoreboard}
            loaded={loadedChart}
            loadError={loadError}
            actions={actions}
            me={me}
            mode={selectedMode ?? "easy"}
            audioEngine={audioEngine}
            audioReady={audioReady}
          />
        );
      case "results":
        return (
          <ResultsScreen
            snapshot={snapshot}
            results={results}
            chat={chat}
            me={me}
            actions={actions}
          />
        );
      default:
        return null;
    }
  })();
  // The countdown / playing phases hand off to <MultiGame>, whose root
  // is `<div class="relative h-full w-full">` - that `h-full` only
  // resolves to a real pixel height if every wrapper between it and the
  // flex-1 game shell also carries an explicit height. Without it, the
  // canvas measures 0×0 (the HUD overlays still paint because they hang
  // off larger ancestors, but the highway itself is invisible - the
  // exact symptom of the "missing game area" bug after a viewport
  // resize). Applying `h-full w-full` for those two phases keeps the
  // chain intact; the lobby / loading / results phases stay in their
  // default auto-height card layout because they're form-style screens
  // that scroll with the page rather than fill it.
  // Only true match participants get the full-bleed canvas shell -
  // in-lobby watchers (inMatch=false) stay in the constrained card
  // layout even when the room phase is `playing`.
  const isCanvasPhase =
    inMatch &&
    (snapshot.phase === "countdown" || snapshot.phase === "playing");
  // Stable key across countdown → playing so React keeps the SAME
  // <MultiGame> instance through the transition. Using `snapshot.phase`
  // here (the previous behavior) caused the wrapper to unmount and
  // remount the moment the server flipped the phase - which destroyed
  // the canvas, rAF loop, and `stats` state that gates the HUD
  // overlays. Visible symptom: the score / combo / rock-meter panels
  // disappeared for ~2 s while the first tick of the rAF loop
  // repopulated `stats`, plus a noticeable gameplay stutter on the
  // first frame as everything reinitialized. (Audio is no longer in
  // the danger list - the AudioEngine lives on this page in
  // `audioEngineRef`, so even a remount of MultiGame doesn't tear
  // down or re-decode the buffer. The fix here is still important
  // for the canvas/rAF/stats half.) Treating both canvas phases as
  // a single "game" shell preserves all of that across the
  // transition; the lobby / loading / results phases still get
  // their own keys so the fade-in animation re-fires on those
  // screens.
  const shellKey = isCanvasPhase ? "game" : snapshot.phase;
  // The lobby phase wants to fill the full viewport height on `lg+`
  // so its internal scrollers (catalog, chat, roster) take over and
  // the page itself doesn't scroll. `lg:flex lg:min-h-0 lg:flex-1
  // lg:flex-col` lets the Lobby grid below use `lg:h-full` to claim
  // the space. Loading / results phases stay in their default
  // auto-height card layout (they're shorter screens that scroll
  // with the page on every breakpoint).
  const isLobbyPhase = snapshot.phase === "lobby" || !inMatch;
  const shellClasses = isCanvasPhase
    ? " h-full w-full"
    : isLobbyPhase
      ? " lg:flex lg:min-h-0 lg:flex-1 lg:flex-col"
      : "";
  // Pre-start countdown overlay - only meaningful in the lobby (the
  // server clears `prestartEndsAt` the moment it flips to `loading`,
  // and we never queue starts from any other phase). Gating on
  // `phase === "lobby"` is belt-and-braces against any race where a
  // late snapshot still carries the field after the transition has
  // landed locally.
  const showPrestart =
    snapshot.phase === "lobby" && snapshot.prestartEndsAt !== null;
  return (
    <div key={shellKey} className={`phase-shell${shellClasses}`}>
      {inner}
      {showPrestart && snapshot.prestartEndsAt !== null && (
        <PrestartOverlay
          endsAt={snapshot.prestartEndsAt}
          isHost={isHost}
          onCancel={actions.cancelStart}
        />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Sub-components                                                         */
/* ---------------------------------------------------------------------- */

function ConnectionPill({ conn }: { conn: string }) {
  const dotClass =
    conn === "connected"
      ? "bg-accent"
      : conn === "disconnected"
        ? "bg-rose-400"
        : "bg-yellow-400 animate-pulse";
  const text =
    conn === "connecting"
      ? "Connecting…"
      : conn === "connected"
        ? "Live"
        : conn === "reconnecting"
          ? "Reconnecting…"
          : "Disconnected";
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-widest text-bone-50/60"
      data-tooltip={text}
    >
      <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`} />
      {/* Hide the verbose label on phones so the room code + back button
          + theme toggle don't fight for space; the colored dot still
          communicates the state, and the data-tooltip exposes the
          full text on hover for assistive / desktop contexts. */}
      <span className="hidden truncate sm:inline">{text}</span>
    </span>
  );
}

function ConnectingCard({ conn }: { conn: string }) {
  // Three states map to three different copy lines so the user always
  // knows what the spinner is waiting on. "connected" lands here only
  // when we have a stored session for this room and the hook is
  // mid-rejoin - the socket handshake itself is already done.
  const label =
    conn === "connected"
      ? "Joining lobby…"
      : conn === "reconnecting"
        ? "Reconnecting to the room…"
        : "Opening socket…";
  return (
    <div className="brut-card mx-auto w-full max-w-md p-5 sm:p-6">
      <p className="font-mono text-[10.5px] uppercase tracking-[0.4em] text-accent">
        ░ {conn === "connected" ? "Joining" : "Connecting"}
      </p>
      <div className="mt-3 flex items-center gap-3">
        <span className="inline-block h-[1.05rem] w-[1.05rem] shrink-0 animate-spin rounded-full border-2 border-bone-50/20 border-t-accent" />
        <p className="font-mono text-[0.79rem] uppercase tracking-widest text-bone-50/80">
          {label}
        </p>
      </div>
      {conn !== "connected" && (
        <p className="mt-3 text-[11.5px] leading-snug text-bone-50/55">
          Server sleeps when idle and takes ~30 s to wake on the first
          connection. Once you&rsquo;re in the room, everything else is
          instant.
        </p>
      )}
    </div>
  );
}

function NoticeStack({
  notices,
}: {
  notices: { id: number; kind: string; text: string }[];
}) {
  if (notices.length === 0) return null;
  return (
    <div className="pointer-events-none fixed right-4 top-20 z-30 flex max-w-xs flex-col items-end gap-2">
      {notices.slice(-5).map((n) => (
        <div
          key={n.id}
          className="brut-card-accent pointer-events-auto px-3 py-2 font-mono text-[11.5px] text-bone-50/90 shadow-lg"
        >
          {n.text}
        </div>
      ))}
    </div>
  );
}

function InvalidCodeScreen({ code, onBack }: { code: string; onBack: () => void }) {
  return (
    <main className="relative min-h-screen">
      <div className="relative z-10 mx-auto flex max-w-md flex-col items-center justify-center gap-4 px-4 py-32 text-center">
        <p className="font-mono text-[10.5px] uppercase tracking-[0.4em] text-rose-400">
          Bad room code
        </p>
        <h1 className="font-display text-[1.97rem] font-bold">{code || "-"}</h1>
        <p className="text-[0.92rem] text-bone-50/70">
          Room codes are 6 characters, A–Z and 2–9. Double-check what your
          friend sent and try again.
        </p>
        <button onClick={onBack} className="brut-btn-accent px-6 py-3">
          Back to multiplayer
        </button>
      </div>
    </main>
  );
}
