import {
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
  /** Per-lane currently-being-held note (for hold mechanics). */
  private activeHold: Array<Note | null> = [null, null, null, null];

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
   */
  hit(lane: number, songTime: number): JudgmentEvent | null {
    let best: { note: Note; delta: number } | null = null;
    for (let i = this.cursor; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.judged) continue;

      const delta = songTime - n.t;
      if (delta < -TIMING.good) {
        if (n.t - songTime > 0.6) break;
        continue;
      }
      if (delta > TIMING.good) continue;
      if (n.lane !== lane) continue;

      const absDelta = Math.abs(delta);
      if (!best || absDelta < Math.abs(best.delta)) {
        best = { note: n, delta };
      }
    }

    if (!best) return null;

    const absDelta = Math.abs(best.delta);
    let judgment: Judgment;
    if (absDelta <= TIMING.perfect) judgment = "perfect";
    else if (absDelta <= TIMING.great) judgment = "great";
    else if (absDelta <= TIMING.good) judgment = "good";
    else return null;

    const evt = this.applyHeadJudgment(best.note, judgment, best.delta, songTime);

    // For holds, register this lane as actively held until release / endT.
    if (isHold(best.note)) {
      this.activeHold[lane] = best.note;
      best.note.holding = true;
    }

    return evt;
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
      // Released way too early — tail miss + combo break.
      judgment = "miss";
    } else if (abs <= TIMING.perfect) judgment = "perfect";
    else if (abs <= TIMING.great)    judgment = "great";
    else if (abs <= TIMING.good)     judgment = "good";
    else                              judgment = "good";

    return this.applyTailJudgment(n, judgment, delta, songTime);
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
    this.events.push(evt);
    if (this.events.length > 32) this.events.shift();
  }
}
