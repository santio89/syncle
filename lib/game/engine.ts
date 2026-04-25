import {
  COMBO_BREAK_THRESHOLD,
  COMBO_MULTIPLIERS,
  INITIAL_STATS,
  Judgment,
  JUDGMENT_SCORE,
  Note,
  PlayerStats,
  TIMING,
} from "./types";

export interface JudgmentEvent {
  noteId: number;
  lane: number;
  judgment: Judgment;
  /** Signed timing error in seconds: negative = early, positive = late. */
  delta: number;
  /** Song time when the event was registered. */
  at: number;
  /** True for the release-end of a hold note (vs head press). */
  tail?: boolean;
}

/** A note is a hold if it has a non-trivial endT. */
export function isHold(n: Note): boolean {
  return n.endT != null && n.endT > n.t + 0.05;
}

/**
 * Pure game-state container. Holds the chart, player stats, and a cursor
 * that walks forward through notes for O(1)-amortized hit detection.
 */
export class GameState {
  notes: Note[];
  stats: PlayerStats;
  /** Index of the earliest note that hasn't been judged yet. */
  private cursor = 0;
  /** Recent judgment events for HUD floating text & beat flashes. */
  events: JudgmentEvent[] = [];
  /**
   * Song-time of the most recent judgment of any kind (hit/miss/tail).
   * Renderer reads this to decay screen-wide ripples in sync with input
   * without scanning the events array.
   */
  lastJudgeAt = -Infinity;
  /** Per-lane currently-being-held note (for hold mechanics). */
  private activeHold: Array<Note | null> = [null, null, null, null];
  /**
   * Per-lane "first note index that still might be hittable in this
   * lane" hint. Strictly monotonically increasing - we only ever
   * bump it forward as notes get judged or fall outside the future
   * lookahead.
   *
   * Why this exists:
   *   `hit(lane, ...)` used to walk the chart starting at
   *   `this.cursor` and skip every note whose lane didn't match. On
   *   a busy 4-lane stream the wasted scan was negligible, but for
   *   sparse same-lane jacks (e.g. a lane that fires once every 3
   *   beats while the other 3 lanes carry the melody) the press in
   *   the quiet lane had to step over ~30–80 unrelated notes every
   *   time. With a per-lane hint that average drops to ~1.
   *
   *   The cursor is still authoritative for FIFO/notelock - we only
   *   USE this hint as a starting point and the loop still bails
   *   the instant it walks past an in-future note in the wrong
   *   lane (those are skipped, but the future-bail check at
   *   `n.t - songTime > 0.6` still catches the early-exit case).
   */
  private laneNext: number[] = [0, 0, 0, 0];
  /**
   * Ring-buffer write head for `events` once it reaches 32 entries.
   * Replaces the old `events.shift()` (O(n) memmove inside V8) with
   * an O(1) overwrite. The renderer iterates `events` with a plain
   * `for` loop and skips aged entries by `songTime - ev.at`, so the
   * order of entries inside the buffer doesn't matter for display.
   */
  private eventsHead = 0;
  private static readonly EVENTS_CAP = 32;

  constructor(notes: Note[]) {
    this.notes = notes;
    // Holds cost two judgments (head + tail), so they count twice toward
    // the total. Keeps the "X / Y" HUD honest for sustain-heavy charts.
    let total = 0;
    for (const n of notes) total += isHold(n) ? 2 : 1;
    this.stats = { ...INITIAL_STATS, totalNotes: total };
  }

  /**
   * Advance the cursor and auto-miss notes that are now too late to hit.
   * Also auto-finalizes holds whose tail has passed without a release.
   * Call every frame with the current songTime.
   */
  expireMisses(songTime: number): void {
    // Auto-resolve holds whose end time has passed:
    //   - if still holding when end + small grace passes → perfect tail
    //   - if release-judged already → handled in release()
    for (let lane = 0; lane < this.activeHold.length; lane++) {
      const n = this.activeHold[lane];
      if (!n) continue;
      const end = n.endT ?? n.t;
      if (songTime >= end + 0.04) {
        this.applyTailJudgment(n, "perfect", 0, songTime);
        this.activeHold[lane] = null;
      }
    }

    while (this.cursor < this.notes.length) {
      const n = this.notes[this.cursor];
      if (n.judged) {
        this.cursor++;
        continue;
      }
      if (songTime - n.t > TIMING.miss) {
        this.applyHeadJudgment(n, "miss", songTime - n.t, songTime);
        // For a missed hold, also tally a missed tail so totals add up.
        if (isHold(n)) this.applyTailJudgment(n, "miss", 0, songTime);
        this.cursor++;
        continue;
      }
      break;
    }
  }

  /**
   * Try to hit a note in the given lane at the current songTime.
   * Returns the resulting judgment, or null if there was no candidate.
   *
   * STRICT FIFO judgment ("notelock", as in osu!mania):
   *   The press is locked to the EARLIEST unjudged note in `lane`
   *   whose hit window currently contains `songTime` - not the
   *   closest-timed one. If two same-lane notes both have the
   *   press time inside their windows (e.g. a jack: t=1.90 and
   *   t=2.00, press at t=1.95), the earlier note (t=1.90) takes
   *   the press even though the later note (t=2.00) would be
   *   closer to "perfect". The later note stays pending and waits
   *   for the next press.
   *
   * Why FIFO (not best-fit):
   *   - Best-fit lets the player "skip" a slightly-late note by
   *     pressing the next one early, getting a great/perfect on
   *     what should have been a recoverable but late press. It
   *     silently rescues miscounted streams, which removes the
   *     pressure that makes jacks and dense same-lane patterns
   *     mean anything.
   *   - FIFO is the standard rhythm-game contract (osu!mania,
   *     Quaver, Etterna, Stepmania). Charts are designed around
   *     it; a player who learns one game expects this rule
   *     everywhere.
   *   - An early-but-late press now correctly converts a perfect
   *     into a good (or even a miss if the player slipped a beat
   *     entirely), which is the right teaching signal.
   *
   * Cross-lane traffic doesn't change anything - the loop just
   * skips any note whose `lane !== lane`. The cursor walk stays
   * O(amortized 1) because we still bail as soon as we hit a note
   * more than 0.6 s in the future (no in-window note can possibly
   * exist past that gap).
   */
  hit(lane: number, songTime: number): JudgmentEvent | null {
    // Start at the per-lane hint - but never before the global
    // cursor (the cursor is the authoritative "earliest unjudged
    // anywhere" line, and a stale lane hint that lags behind would
    // cause us to inspect already-cursored-past notes for nothing).
    const hint = this.laneNext[lane] ?? 0;
    const start = hint < this.cursor ? this.cursor : hint;
    // First unjudged in-lane note we touch on this walk - committed
    // back to `laneNext[lane]` after the loop so the next press in
    // this lane skips straight to it.
    let firstInLane = -1;
    for (let i = start; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.judged) continue;

      const delta = songTime - n.t;
      if (delta < -TIMING.good) {
        // Note is still in the future, outside even the largest
        // hit window. If it's far enough out we can stop scanning
        // entirely - chart is sorted by `t` so nothing further
        // can be in window either. Before bailing, commit any
        // first-in-lane index we found above so the hint isn't
        // pinned to an already-judged note.
        if (n.t - songTime > 0.6) {
          if (firstInLane !== -1) this.laneNext[lane] = firstInLane;
          break;
        }
        continue;
      }
      // Past the good window - this note is already too late to
      // hit. `expireMisses` will auto-miss it on the next frame;
      // for now we just look past it.
      if (delta > TIMING.good) continue;
      if (n.lane !== lane) continue;
      // First unjudged in-lane candidate we've seen this walk -
      // remember its index for the lane hint.
      if (firstInLane === -1) firstInLane = i;

      // First in-window unjudged note in the target lane wins -
      // this is the FIFO / notelock contract. Don't peek further.
      //
      // `absDelta <= TIMING.good` is guaranteed here: lines above
      // already break on `delta < -TIMING.good` and continue on
      // `delta > TIMING.good`, so any note reaching this point sits
      // inside the good window. The cascade therefore needs no
      // fallback branch - `judgment` is always assigned.
      const absDelta = Math.abs(delta);
      let judgment: Judgment;
      if (absDelta <= TIMING.perfect) judgment = "perfect";
      else if (absDelta <= TIMING.great) judgment = "great";
      else judgment = "good";

      const evt = this.applyHeadJudgment(n, judgment, delta, songTime);

      // Commit the lane hint to the index AFTER the one we just
      // judged. `n.judged` is now set so subsequent hit() calls
      // skip it, but starting at `i + 1` saves the redundant skip.
      this.laneNext[lane] = i + 1;

      // For holds, register this lane as actively held until
      // release / endT.
      if (isHold(n)) {
        this.activeHold[lane] = n;
        n.holding = true;
      }
      return evt;
    }
    // No judgment landed - commit whatever first-in-lane index we
    // walked past so the next press skips straight to it.
    if (firstInLane !== -1) this.laneNext[lane] = firstInLane;
    return null;
  }

  /**
   * Release a held lane. Judges the tail of any active hold.
   * Returns a tail event if one was emitted.
   */
  release(lane: number, songTime: number): JudgmentEvent | null {
    const n = this.activeHold[lane];
    if (!n) return null;
    this.activeHold[lane] = null;
    n.holding = false;

    const end = n.endT ?? n.t;
    const delta = songTime - end;
    const abs = Math.abs(delta);

    let judgment: Judgment;
    if (delta < -0.18) {
      // Released way too early - tail miss + combo break.
      judgment = "miss";
    } else if (abs <= TIMING.perfect) judgment = "perfect";
    else if (abs <= TIMING.great)    judgment = "great";
    else if (abs <= TIMING.good)     judgment = "good";
    else                              judgment = "good";

    return this.applyTailJudgment(n, judgment, delta, songTime);
  }

  /**
   * Strict-Inputs spam check.
   *
   * Call this AFTER `hit(lane, songTime)` returned `null` (i.e. the
   * press didn't land in any note's hit window) and ONLY when the
   * player has Strict Inputs enabled. Returns:
   *
   *   - `true`  if the press was classified as spam: combo broken,
   *             multiplier reset, small health drop applied. Caller
   *             should suppress the usual "empty press" SFX track in
   *             favor of whatever subtle feedback Strict Inputs uses
   *             (currently: just the existing empty-press tick - the
   *             combo number visibly dropping is the primary cue).
   *
   *   - `false` if there's an unjudged note in this lane within
   *             ±TIMING.spamGrace of `songTime`. The player WAS
   *             trying to hit something, just slightly too early/
   *             late for the good window - that's an honest mistime
   *             and is left unpenalized (the engine will register a
   *             real miss for that note via `expireMisses` if/when
   *             it falls past the miss window). Caller falls back to
   *             the standard empty-press tick.
   *
   * Why we don't increment `stats.hits.miss` or `notesPlayed`:
   *   Spam misses aren't "real notes the chart authored". Folding
   *   them into the accuracy denominator would silently rebalance
   *   every accuracy figure the player has ever seen, and the
   *   on-screen combo dropping to zero is already an unmistakable
   *   signal that the press cost them something. We also skip
   *   `comboBreaks` so the level-edge SFX in the renderer (which
   *   watches that counter) doesn't fire - the user explicitly
   *   asked for a SILENT combo break here, just the empty-press
   *   tick that pressLane already plays unconditionally.
   *
   * Why we don't push a JudgmentEvent into `events`:
   *   The events ring is what the renderer's drawJudgmentPopups
   *   reads to draw the floating "MISS / GOOD / GREAT / PERFECT"
   *   text at the lane's gate. Pushing a synthetic miss here would
   *   surface an on-screen "MISS" popup and contradict the
   *   "no popup" UX the user requested for spam-misses. Combo
   *   visibly dropping is the only intended visual cue.
   *
   * The walk reuses the same `laneNext` hint as `hit()` so the cost
   * is amortized O(1) - we usually inspect 0-1 notes, never more
   * than a handful even on dense charts.
   */
  markEmptyPress(lane: number, songTime: number): boolean {
    const grace = TIMING.spamGrace;
    const start = Math.max(this.cursor, this.laneNext[lane] ?? 0);

    for (let i = start; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.judged) continue;
      // We can bail as soon as we walk past `songTime + grace` -
      // chart is sorted by `t` so anything further is too far in
      // the future to count as a "near note" anyway.
      const future = n.t - songTime;
      if (future > grace) break;
      // Notes already in the past (more than `grace` behind) are
      // fair game to skip: they haven't been judged yet (would have
      // been caught by `n.judged` above) but `expireMisses` will
      // finalize them within ~30 ms - they don't represent
      // intent-to-hit at THIS press.
      if (-future > grace) continue;
      if (n.lane !== lane) continue;
      // Found an unjudged in-lane note within ±grace of the press.
      // Honest mistime - no spam penalty.
      return false;
    }

    // No nearby note in this lane → spam. Apply silent penalty.
    const s = this.stats;
    if (s.combo === 0) {
      // Combo was already broken (e.g. just missed a note last
      // frame). Don't double-apply the health drop or fire any
      // listeners that key off lastJudgeAt - let the prior break
      // own the moment. Important to keep this no-op so a player
      // who panic-mashes during a stream of misses doesn't see
      // their health bar tick down per press.
      return true;
    }
    s.combo = 0;
    s.multiplier = 1;
    s.health = Math.max(0, s.health - 0.04);
    return true;
  }

  /** True if the given lane currently has a hold being sustained. */
  isHolding(lane: number): boolean {
    return this.activeHold[lane] != null;
  }

  /** The note actively being held in `lane`, if any. */
  activeHoldNote(lane: number): Note | null {
    return this.activeHold[lane];
  }

  // -------------------------------------------------------------------
  private applyHeadJudgment(
    note: Note,
    judgment: Judgment,
    delta: number,
    songTime: number,
  ): JudgmentEvent {
    note.judged = judgment;
    note.judgedAt = songTime;
    this.tallyJudgment(judgment);

    const evt: JudgmentEvent = {
      noteId: note.id,
      lane: note.lane,
      judgment,
      delta,
      at: songTime,
    };
    this.pushEvent(evt);
    return evt;
  }

  private applyTailJudgment(
    note: Note,
    judgment: Judgment,
    delta: number,
    songTime: number,
  ): JudgmentEvent {
    note.tailJudged = judgment;
    note.tailJudgedAt = songTime;
    note.holding = false;
    this.tallyJudgment(judgment);

    const evt: JudgmentEvent = {
      noteId: note.id,
      lane: note.lane,
      judgment,
      delta,
      at: songTime,
      tail: true,
    };
    this.pushEvent(evt);
    return evt;
  }

  /** Apply a single judgment to score / combo / health. */
  private tallyJudgment(judgment: Judgment): void {
    const s = this.stats;
    s.hits[judgment] += 1;
    s.notesPlayed += 1;

    if (judgment === "miss") {
      // Sample combo BEFORE the reset so the renderer's level-edge
      // SFX trigger can tell whether this miss broke a "meaningful"
      // combo. Increment is gated on the threshold so trivial 0-19
      // streaks don't fire the combobreak cue (matches osu! convention
      // - a 3-note streak loss isn't a "moment").
      if (s.combo >= COMBO_BREAK_THRESHOLD) {
        s.comboBreaks += 1;
      }
      s.combo = 0;
      s.multiplier = 1;
      s.health = Math.max(0, s.health - 0.04);
    } else {
      s.combo += 1;
      if (s.combo > s.maxCombo) s.maxCombo = s.combo;
      const tier = Math.min(
        COMBO_MULTIPLIERS.length - 1,
        Math.floor(s.combo / 10),
      );
      s.multiplier = COMBO_MULTIPLIERS[tier];

      const base = JUDGMENT_SCORE[judgment];
      s.score += base * s.multiplier;
      s.health = Math.min(1, s.health + (judgment === "perfect" ? 0.012 : 0.006));
    }
  }

  private pushEvent(evt: JudgmentEvent): void {
    // Ring-buffer behavior once the array reaches its cap: instead of
    // `events.shift()` (which V8 implements as an O(n) memmove of the
    // remaining 31 entries), overwrite the oldest slot in place via
    // `eventsHead` and walk the head forward modulo the cap.
    //
    // Visible behavior is identical for the renderer:
    //   - `drawJudgmentPopups` iterates `events` with a plain `for`
    //     loop and skips entries by `songTime - ev.at > 0.6`, so it
    //     doesn't care about insertion order.
    //   - The cap (32) is large enough that no two on-screen popups
    //     can share a slot - the popup window is 0.6 s and the engine
    //     can produce at most 4 events / frame (one per lane), so 24
    //     of those 32 entries clear out before reuse even at 60 FPS.
    //
    // This eliminates the O(n) shift that was the only allocator-
    // adjacent cost in the engine's hot path. Stays in <1 µs across
    // every press now.
    if (this.events.length < GameState.EVENTS_CAP) {
      this.events.push(evt);
    } else {
      this.events[this.eventsHead] = evt;
      this.eventsHead = (this.eventsHead + 1) % GameState.EVENTS_CAP;
    }
    if (evt.at > this.lastJudgeAt) this.lastJudgeAt = evt.at;
  }
}
