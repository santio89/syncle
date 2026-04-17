import { Judgment, LANE_PITCH } from "./types";

/**
 * Audio engine wrapper around the Web Audio API.
 *
 * Why Web Audio API instead of <audio>?
 *   - sample-accurate scheduling via AudioContext.currentTime
 *   - immune to JS event-loop jitter
 *   - lets us derive "song time" from the audio clock, not requestAnimationFrame
 *
 * In addition to song playback this engine produces gameplay feedback:
 *   - playHit(lane, judgment) — a short pluck tone in the song's key,
 *     pitched per lane. Perfect hits get a shimmer overtone.
 *   - playMiss() / playEmpty() — a dull thud + a brief volume duck and
 *     low-pass filter sweep on the song. The song literally sounds "off"
 *     for ~250ms when you whiff, like an unplugged guitar moment.
 *   - scheduleClick(beatTime, downbeat) — a metronome tick scheduled at a
 *     specific AudioContext time. Used to verify rhythm sync.
 *
 * Signal graph:
 *   source → songFilter (lowpass) → songGain → master → destination
 *   sfx    → sfxGain → master → destination
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;

  private master: GainNode | null = null;
  private songGain: GainNode | null = null;
  private songFilter: BiquadFilterNode | null = null;
  private sfxGain: GainNode | null = null;

  /** AudioContext.currentTime at which the song's t=0 lines up. */
  private startedAtCtxTime = 0;
  private playing = false;
  private duration_ = 0;
  private songVol = 0.85;

  private metronomeOn = false;

  get duration(): number {
    return this.duration_;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /** Make sure we have an audio context (must be created on user gesture). */
  ensureContext(): AudioContext {
    if (!this.ctx) {
      const Ctor =
        (window as any).AudioContext || (window as any).webkitAudioContext;
      this.ctx = new Ctor();
      // Persistent SFX bus so feedback works even before song starts.
      this.master = this.ctx!.createGain();
      this.master.gain.value = 1;
      this.master.connect(this.ctx!.destination);

      this.sfxGain = this.ctx!.createGain();
      this.sfxGain.gain.value = 0.6;
      this.sfxGain.connect(this.master);
    }
    if (this.ctx!.state === "suspended") {
      void this.ctx!.resume();
    }
    return this.ctx!;
  }

  async load(url: string): Promise<void> {
    const ctx = this.ensureContext();
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to load audio: ${res.status}`);
    const arr = await res.arrayBuffer();
    this.buffer = await ctx.decodeAudioData(arr);
    this.duration_ = this.buffer.duration;
  }

  /**
   * Schedule the song to start `delay` seconds from now.
   * Returns the AudioContext time at which the song will begin (= songTime 0).
   */
  start(delay: number = 0, volume: number = 0.85): number {
    if (!this.ctx || !this.buffer) {
      throw new Error("Audio not loaded");
    }
    this.stop();
    this.songVol = volume;

    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;

    const filt = this.ctx.createBiquadFilter();
    filt.type = "lowpass";
    filt.frequency.value = 22000; // effectively bypass until ducked
    filt.Q.value = 0.7;

    const gain = this.ctx.createGain();
    // Quick fade-in so the song never "pops" — half a beat is plenty.
    gain.gain.setValueAtTime(0, this.ctx.currentTime);

    src.connect(filt).connect(gain).connect(this.master!);

    const startAt = this.ctx.currentTime + Math.max(0, delay);
    src.start(startAt);
    gain.gain.setValueAtTime(0, startAt);
    gain.gain.linearRampToValueAtTime(volume, startAt + 0.06);

    this.source = src;
    this.songFilter = filt;
    this.songGain = gain;
    this.startedAtCtxTime = startAt;
    this.playing = true;

    src.onended = () => {
      this.playing = false;
    };

    return startAt;
  }

  /**
   * Suspend the AudioContext. Because everything (song playback, scheduled
   * metronome clicks, currentTime) is anchored to that clock, suspending
   * cleanly freezes the world — songTime() stops advancing too. Resume()
   * picks up exactly where we left off.
   */
  async pause(): Promise<void> {
    if (this.ctx && this.ctx.state === "running") {
      try {
        await this.ctx.suspend();
      } catch {
        /* ignore */
      }
    }
  }

  async resume(): Promise<void> {
    if (this.ctx && this.ctx.state === "suspended") {
      try {
        await this.ctx.resume();
      } catch {
        /* ignore */
      }
    }
  }

  get isPaused(): boolean {
    return this.ctx?.state === "suspended";
  }

  stop(): void {
    if (this.source) {
      try {
        this.source.onended = null;
        this.source.stop();
      } catch {
        /* ignore */
      }
      this.source.disconnect();
      this.source = null;
    }
    if (this.songGain) {
      this.songGain.disconnect();
      this.songGain = null;
    }
    if (this.songFilter) {
      this.songFilter.disconnect();
      this.songFilter = null;
    }
    this.playing = false;
  }

  /**
   * Current song time (seconds since song t=0).
   * Negative during the lead-in countdown.
   */
  songTime(): number {
    if (!this.ctx) return 0;
    return this.ctx.currentTime - this.startedAtCtxTime;
  }

  /** Convert a song-time value into AudioContext time (for scheduling). */
  ctxTimeAt(songTime: number): number {
    return this.startedAtCtxTime + songTime;
  }

  setVolume(v: number): void {
    const clamped = Math.min(1, Math.max(0, v));
    this.songVol = clamped;
    if (this.songGain && this.ctx) {
      const t = this.ctx.currentTime;
      const g = this.songGain.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(clamped, t + 0.05);
    }
  }

  setMetronome(on: boolean): void {
    this.metronomeOn = on;
  }

  // ---------------------------------------------------------------------
  // Gameplay feedback
  // ---------------------------------------------------------------------

  /** A satisfying pluck tone for a successful hit. */
  playHit(lane: number, judgment: Judgment): void {
    if (!this.ctx || !this.sfxGain) return;
    const t = this.ctx.currentTime;

    const freq = LANE_PITCH[lane] ?? 220;
    const vol =
      judgment === "perfect" ? 0.32 :
      judgment === "great"   ? 0.24 :
      judgment === "good"    ? 0.16 : 0.16;

    this.pluck(t, freq, 0.35, vol, "triangle");
    if (judgment === "perfect") {
      // Octave-up shimmer for that "you nailed it" feeling.
      this.pluck(t + 0.002, freq * 2, 0.22, 0.10, "sine");
    } else if (judgment === "good") {
      // Slightly detuned 2nd voice — still musical, but a hint "off".
      this.pluck(t, freq * 1.012, 0.25, 0.10, "triangle");
    }
  }

  /** A short, soft tone for the release of a hold note's tail. */
  playRelease(lane: number, judgment: Judgment): void {
    if (!this.ctx || !this.sfxGain) return;
    const t = this.ctx.currentTime;
    const freq = (LANE_PITCH[lane] ?? 220) * 1.5; // 5th above the head
    const vol =
      judgment === "perfect" ? 0.18 :
      judgment === "great"   ? 0.14 :
      judgment === "good"    ? 0.10 : 0.0;
    if (vol > 0) this.pluck(t, freq, 0.28, vol, "sine");
    if (judgment === "miss") this.playMiss(false);
  }

  /** A miss: dull thud + briefly muffle the song so it sounds wrong. */
  playMiss(empty: boolean = false): void {
    if (!this.ctx || !this.sfxGain) return;
    const t = this.ctx.currentTime;

    // Dull descending thud.
    const osc = this.ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(140, t);
    osc.frequency.exponentialRampToValueAtTime(55, t + 0.18);

    const filt = this.ctx.createBiquadFilter();
    filt.type = "lowpass";
    filt.frequency.value = 700;

    const env = this.ctx.createGain();
    const peak = empty ? 0.10 : 0.18;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(peak, t + 0.005);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);

    osc.connect(filt).connect(env).connect(this.sfxGain);
    osc.start(t);
    osc.stop(t + 0.25);

    if (!empty) this.duckSong();
  }

  /** Briefly drops song volume + applies a lowpass for that "unplugged" moment. */
  duckSong(amountFactor = 0.4, durMs = 240): void {
    if (!this.songGain || !this.songFilter || !this.ctx) return;
    const t = this.ctx.currentTime;
    const dur = durMs / 1000;
    const vol = this.songVol;

    const g = this.songGain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(vol * amountFactor, t + 0.04);
    g.linearRampToValueAtTime(vol, t + dur);

    const f = this.songFilter.frequency;
    f.cancelScheduledValues(t);
    f.setValueAtTime(f.value, t);
    f.linearRampToValueAtTime(700, t + 0.04);
    f.linearRampToValueAtTime(22000, t + dur);
  }

  /** Schedule a metronome click at a given AudioContext time. */
  scheduleClick(when: number, downbeat: boolean): void {
    if (!this.ctx || !this.sfxGain || !this.metronomeOn) return;
    const osc = this.ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = downbeat ? 1500 : 1000;

    const env = this.ctx.createGain();
    const peak = downbeat ? 0.18 : 0.09;
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(peak, when + 0.002);
    env.gain.exponentialRampToValueAtTime(0.0001, when + 0.06);

    osc.connect(env).connect(this.sfxGain);
    osc.start(when);
    osc.stop(when + 0.1);
  }

  // ---------------------------------------------------------------------
  private pluck(
    when: number,
    freq: number,
    dur: number,
    vol: number,
    type: OscillatorType = "triangle",
  ): void {
    if (!this.ctx || !this.sfxGain) return;
    const ctx = this.ctx;

    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, when);
    // gentle pitch droop for a plucky feel
    osc.frequency.exponentialRampToValueAtTime(freq * 0.985, when + dur);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(vol, when + 0.005);
    env.gain.exponentialRampToValueAtTime(0.0001, when + dur);

    osc.connect(env).connect(this.sfxGain);
    osc.start(when);
    osc.stop(when + dur + 0.05);
  }
}
