import { Judgment, LANE_PITCH } from "./types";

/**
 * Base level of the per-input feedback SFX bus. The actual `sfxGain.gain`
 * value is `BASE_SFX_LEVEL * songVol`, so when the player pulls the master
 * volume down, the hit / miss / release tones fall off in lockstep instead
 * of staying loud over a quiet song. Picked low (vs the song bus's 1.0
 * ceiling) so a stack of perfect-pluck + metronome click + combo chime
 * still leaves headroom under the limiter.
 */
const BASE_SFX_LEVEL = 0.45;

/**
 * Audio engine wrapper around the Web Audio API.
 *
 * Why Web Audio API instead of <audio>?
 *   - sample-accurate scheduling via AudioContext.currentTime
 *   - immune to JS event-loop jitter
 *   - lets us derive "song time" from the audio clock, not requestAnimationFrame
 *
 * Sync model — read this before changing how songTime is consumed:
 *   - `songTime()` returns `ctx.currentTime - startedAtCtxTime`, which is
 *     the audio clock's "next sample to be processed" view of the song
 *     position. That's the right value for SCHEDULING things forward
 *     (metronome clicks, future SFX) because they go straight onto the
 *     same buffer the clock advances.
 *   - For JUDGING input, prefer `inputSongTime(e.timeStamp)`. It captures
 *     the audio-clock position at the EXACT performance.now() moment the
 *     KeyboardEvent fired (eliminating handler-dispatch lag, which the
 *     browser can hold for 1-15 ms under load) and then subtracts the
 *     audible-output latency so we compare against the chart-time the
 *     player ACTUALLY heard at press time, not the buffer-pump time.
 *     Without these two corrections, a perfectly timed press skews
 *     inconsistently late by 5-30 ms depending on device + OS audio
 *     buffer size, which is the dominant cause of "feels off sometimes".
 *
 * In addition to song playback this engine produces gameplay feedback:
 *   - playHit(lane, judgment) — a short pluck tone in the song's key,
 *     pitched per lane. Perfect hits get a 5th-up shimmer.
 *   - playMiss() / playEmpty() — a dull thud + a brief volume duck and
 *     low-pass filter sweep on the song. The song literally sounds "off"
 *     for ~250ms when you whiff, like an unplugged guitar moment.
 *   - scheduleClick(beatTime, downbeat) — a metronome tick scheduled at a
 *     specific AudioContext time. Used to verify rhythm sync.
 *
 * Signal graph:
 *   source → songFilter (lowpass) → songGain → master → limiter → destination
 *   sfx    → sfxGain → master → limiter → destination
 *
 * `sfxGain.gain = BASE_SFX_LEVEL * songVol` so master volume controls
 * both buses; the player can never get loud SFX over a quiet song.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  /** URL of the audio currently in `buffer`. Used to skip redundant decodes. */
  private loadedUrl: string | null = null;
  /** In-flight load promise so concurrent load() calls de-dupe. */
  private loading: Promise<void> | null = null;

  private master: GainNode | null = null;
  /** Soft master limiter — catches transient clip when many SFX overlap. */
  private limiter: DynamicsCompressorNode | null = null;
  private songGain: GainNode | null = null;
  private songFilter: BiquadFilterNode | null = null;
  private sfxGain: GainNode | null = null;

  /** AudioContext.currentTime at which the song's t=0 lines up. */
  private startedAtCtxTime = 0;
  private playing = false;
  private duration_ = 0;
  private songVol = 0.85;

  private metronomeOn = false;
  /**
   * When false, suppress per-input feedback SFX (hit pluck, miss thud,
   * release tone, combo-milestone chime, and the song's "duck" cue that
   * stacks on a miss). Independent from `metronomeOn` so a player who
   * wants the rhythm tick but no input SFX (or vice versa) gets that.
   * Song playback itself is unaffected; that has its own volume slider.
   */
  private sfxOn = true;

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

      // Soft-knee limiter at ~ -2 dBFS. It rarely triggers during normal
      // play but absorbs the brief peaks when a perfect-tap pluck stacks
      // on top of a metronome click + a high-velocity drum from the song.
      // Without this, those transients clip on Chrome's default destination
      // and you hear a tiny crackle. The compressor's small lookahead also
      // smooths the SFX sum so combo chains don't get harsh.
      this.limiter = this.ctx!.createDynamicsCompressor();
      this.limiter.threshold.value = -2;   // dB
      this.limiter.knee.value = 6;
      this.limiter.ratio.value = 8;
      this.limiter.attack.value = 0.003;
      this.limiter.release.value = 0.18;
      this.limiter.connect(this.ctx!.destination);

      // Persistent SFX bus so feedback works even before song starts.
      this.master = this.ctx!.createGain();
      this.master.gain.value = 1;
      this.master.connect(this.limiter);

      this.sfxGain = this.ctx!.createGain();
      // Initial level honours the persisted master volume (set via
      // setVolume() before start()), so the very first tap a player
      // makes — possibly during the lead-in countdown, before any
      // setVolume() call lands — already respects their slider.
      this.sfxGain.gain.value = BASE_SFX_LEVEL * this.songVol;
      this.sfxGain.connect(this.master);
    }
    if (this.ctx!.state === "suspended") {
      void this.ctx!.resume();
    }
    return this.ctx!;
  }

  /**
   * Fetch + decode an audio URL. Idempotent: calling with the same URL twice
   * returns immediately on the second call (the decoded AudioBuffer is kept).
   * Concurrent calls with the same URL share the same in-flight promise so
   * we never decode the same bytes twice.
   *
   * Note: decodeAudioData works on a suspended AudioContext, so this can be
   * called BEFORE the user gesture that resumes the context — useful for
   * pre-decoding while the start card is on screen.
   */
  async load(url: string): Promise<void> {
    if (this.loadedUrl === url && this.buffer) return;
    if (this.loading) await this.loading.catch(() => {});
    if (this.loadedUrl === url && this.buffer) return;

    this.loading = (async () => {
      // force-cache so repeated loads (same session, retries) are zero-byte.
      const res = await fetch(url, { cache: "force-cache" });
      if (!res.ok) throw new Error(`Failed to load audio: ${res.status}`);
      const arr = await res.arrayBuffer();
      await this.decodeInto(arr);
      this.loadedUrl = url;
    })();
    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
  }

  /**
   * Decode an in-memory audio buffer (used by the oszFetcher path, where the
   * bytes come out of an unzipped .osz rather than a URL). The `key` is an
   * opaque dedup token — pass the same key on subsequent calls to skip the
   * decode if the buffer is already in place.
   */
  async loadFromBytes(buf: ArrayBuffer, key: string): Promise<void> {
    if (this.loadedUrl === key && this.buffer) return;
    if (this.loading) await this.loading.catch(() => {});
    if (this.loadedUrl === key && this.buffer) return;

    this.loading = (async () => {
      // decodeAudioData detaches its input — slice if you need the bytes
      // for anything else after this call.
      await this.decodeInto(buf);
      this.loadedUrl = key;
    })();
    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
  }

  private async decodeInto(buf: ArrayBuffer): Promise<void> {
    const ctx = this.ensureContext();
    this.buffer = await ctx.decodeAudioData(buf);
    this.duration_ = this.buffer.duration;
  }

  /** True once an audio buffer is decoded and ready for `start()`. */
  get isLoaded(): boolean {
    return this.buffer != null;
  }

  /**
   * Schedule the song to start `delay` seconds from now, optionally seeking
   * `offset` seconds into the audio buffer.
   *
   * `songTime()` is anchored to *audio start*, so the audio clock t=0 always
   * corresponds to the position in the buffer the playback head is at when
   * the source starts. With a non-zero `offset` we shift `startedAtCtxTime`
   * BACK by that amount so songTime() returns realistic chart-relative
   * timings — i.e. a player joining 30s into a song will read songTime ≈ 30
   * on their first frame, lining up perfectly with the chart's notes.
   *
   * Returns the AudioContext time at which (logical) songTime = 0.
   */
  start(delay: number = 0, volume: number = 0.85, offset: number = 0): number {
    if (!this.ctx || !this.buffer) {
      throw new Error("Audio not loaded");
    }
    this.stop();
    this.songVol = volume;
    const safeOffset = Math.max(0, Math.min(this.buffer.duration - 0.05, offset));

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
    src.start(startAt, safeOffset);
    gain.gain.setValueAtTime(0, startAt);
    // Slightly longer fade for late-join so the seeked-into frame doesn't
    // crackle from being mid-waveform; 60ms still feels instantaneous.
    const fadeLen = safeOffset > 0 ? 0.12 : 0.06;
    gain.gain.linearRampToValueAtTime(volume, startAt + fadeLen);

    this.source = src;
    this.songFilter = filt;
    this.songGain = gain;
    // Logical t=0 sits `safeOffset` BEHIND the actual audio start so
    // songTime() reports chart-relative time even mid-song.
    this.startedAtCtxTime = startAt - safeOffset;
    this.playing = true;

    src.onended = () => {
      this.playing = false;
    };

    return this.startedAtCtxTime;
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
   *
   * This is the "next sample to be processed" time — correct for FORWARD
   * scheduling (metronome clicks, future SFX). For judging input that the
   * player just made, prefer {@link inputSongTime} so handler-dispatch lag
   * and audible-output latency are factored out.
   */
  songTime(): number {
    if (!this.ctx) return 0;
    return this.ctx.currentTime - this.startedAtCtxTime;
  }

  /**
   * The audible-output latency: how far behind `ctx.currentTime` the
   * sample currently leaving the speakers actually is. Set by the audio
   * subsystem based on driver/buffer size; can be 0 on contexts that
   * don't expose it (older Safari, certain headless test environments).
   * Falls back to `baseLatency` (process-internal buffering only) and
   * finally 0 so callers never have to null-check.
   */
  outputLatency(): number {
    const ctx = this.ctx as (AudioContext & { outputLatency?: number }) | null;
    if (!ctx) return 0;
    if (typeof ctx.outputLatency === "number" && ctx.outputLatency >= 0) {
      return ctx.outputLatency;
    }
    if (typeof ctx.baseLatency === "number" && ctx.baseLatency >= 0) {
      return ctx.baseLatency;
    }
    return 0;
  }

  /**
   * Song time corresponding to a real-world input event.
   *
   * Two corrections vs the raw `songTime()`:
   *   1. **Dispatch lag** — `eventTimestamp` is the `performance.now()`
   *      moment the browser created the event (typically the physical
   *      key press), but the handler may not run for several ms after.
   *      We back the audio clock up by exactly that gap so the judgment
   *      uses "audio clock at press", not "audio clock when handler ran".
   *      Both `performance.now()` and `ctx.currentTime` advance in real
   *      time, so the gap is directly comparable in seconds.
   *   2. **Audible-output latency** — `ctx.currentTime` is the next
   *      sample heading into the audio device, but the player's ear is
   *      hearing a sample emitted `outputLatency()` seconds earlier.
   *      Subtracting it means we judge against the chart-time the
   *      player ACTUALLY heard at press, not the buffer-pump time.
   *
   * Without these corrections, a metronome-perfect tap on a device with
   * a 20ms output buffer reads as "great" instead of "perfect" — a
   * full timing window off, consistently late, but only on some setups.
   *
   * Pass the event's `timeStamp` (KeyboardEvent / PointerEvent / etc).
   * If undefined, falls back to plain `songTime()` so we degrade
   * gracefully on synthetic call sites.
   */
  inputSongTime(eventTimestamp?: number): number {
    if (!this.ctx) return 0;
    if (eventTimestamp == null || !Number.isFinite(eventTimestamp)) {
      return this.ctx.currentTime - this.startedAtCtxTime - this.outputLatency();
    }
    // Cap the dispatch-lag correction at 0..120ms. Negative would mean
    // the event is "from the future" (clock skew or stale closure on
    // a paused-then-resumed context); huge positive values usually mean
    // a queued event from before a tab unfreeze. Either case: don't
    // let a pathological reading bend the judgment by half a beat.
    const lagSec = Math.min(
      0.12,
      Math.max(0, (performance.now() - eventTimestamp) / 1000),
    );
    return (
      this.ctx.currentTime - lagSec - this.startedAtCtxTime - this.outputLatency()
    );
  }

  /** Convert a song-time value into AudioContext time (for scheduling). */
  ctxTimeAt(songTime: number): number {
    return this.startedAtCtxTime + songTime;
  }

  setVolume(v: number): void {
    const clamped = Math.min(1, Math.max(0, v));
    this.songVol = clamped;
    // Both buses get a 50ms linear ramp instead of an instant set —
    // a hard step in gain produces an audible click on the running
    // signal, especially mid-song. The two ramps run in lockstep so
    // there's no transient where SFX briefly sit louder/quieter than
    // the song would suggest.
    if (this.ctx) {
      const t = this.ctx.currentTime;
      if (this.songGain) {
        const g = this.songGain.gain;
        g.cancelScheduledValues(t);
        g.setValueAtTime(g.value, t);
        g.linearRampToValueAtTime(clamped, t + 0.05);
      }
      if (this.sfxGain) {
        const g = this.sfxGain.gain;
        g.cancelScheduledValues(t);
        g.setValueAtTime(g.value, t);
        g.linearRampToValueAtTime(BASE_SFX_LEVEL * clamped, t + 0.05);
      }
    }
  }

  setMetronome(on: boolean): void {
    this.metronomeOn = on;
  }

  /**
   * Master switch for per-input feedback SFX. Mirrors `setMetronome` —
   * the engine still functions normally, the gated `playHit` / `playMiss`
   * / `playRelease` / `playComboMilestone` calls just no-op. Cheap,
   * stateless, safe to flip mid-song.
   */
  setSfx(on: boolean): void {
    this.sfxOn = on;
  }

  // ---------------------------------------------------------------------
  // Gameplay feedback
  // ---------------------------------------------------------------------

  /**
   * A soft pluck tone for a successful hit.
   *
   * Sine base voice (was triangle) — sine has no harmonics above the
   * fundamental, so a stream of taps reads as a melodic chime instead
   * of the slightly buzzy "pencil tap" the triangle wave produced.
   * The overall envelope is the same plucked shape (fast-ish attack,
   * exponential decay over ~350ms); only the timbre is gentler.
   *
   * Per-judgment volumes also dropped ~30% so a tight stream of perfect
   * taps doesn't drown the song. Combined with the master-volume-aware
   * sfx bus, the player now has a real range of feedback levels — quiet
   * songs keep the SFX quiet, loud songs let them shine.
   */
  playHit(lane: number, judgment: Judgment): void {
    if (!this.ctx || !this.sfxGain) return;
    if (!this.sfxOn) return;
    const t = this.ctx.currentTime;

    const freq = LANE_PITCH[lane] ?? 220;
    const vol =
      judgment === "perfect" ? 0.22 :
      judgment === "great"   ? 0.17 :
      judgment === "good"    ? 0.12 : 0.12;

    this.pluck(t, freq, 0.36, vol, "sine");
    if (judgment === "perfect") {
      // 5th-up sine shimmer (was octave-up). The 5th sits inside the
      // chord most charts use, so the perfect cue feels "in tune" with
      // the song rather than dropping a bright bell on top.
      this.pluck(t + 0.002, freq * 1.5, 0.26, 0.075, "sine");
    }
    // No "good" detune voice — a deliberately dissonant cue read as a
    // wobble that confused players into thinking the engine itself was
    // off-pitch. The lower base volume + lack of shimmer is enough to
    // signal "good, but not great" without an audible warble.
  }

  /** A short, soft tone for the release of a hold note's tail. */
  playRelease(lane: number, judgment: Judgment): void {
    if (!this.ctx || !this.sfxGain) return;
    if (!this.sfxOn) return;
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
    // Gating playMiss here also suppresses the song-duck cue below
    // (which only fires from this method), so when the player turns
    // SFX off they get pure music with zero whiff feedback — exactly
    // what the toggle promises.
    if (!this.sfxOn) return;
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
    const peak = empty ? 0.11 : 0.20;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(peak, t + 0.005);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);

    osc.connect(filt).connect(env).connect(this.sfxGain);
    osc.start(t);
    osc.stop(t + 0.25);

    if (!empty) this.duckSong();
  }

  /**
   * Briefly drops song volume, low-passes it, and pitch-bends the source
   * down — three independent "off" cues stacked so a miss feels viscerally
   * wrong without being painful.
   *
   *   amountFactor    multiplier on song volume during the dip (0..1)
   *   durMs           total duration of the dip + recovery
   *   detuneCents     pitch drop on the source in cents (100 = 1 semitone).
   *                   ~55 cents sits between a quarter- and half-tone:
   *                   audibly off without sounding broken. Recovers fast
   *                   so consecutive misses don't compound into a mess.
   */
  duckSong(amountFactor = 0.36, durMs = 260, detuneCents = 55): void {
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
    // 650Hz cutoff sits between the original 700 and the harsher 600 —
    // muffles the song just enough to feel physical without sounding
    // underwater on consecutive misses.
    f.linearRampToValueAtTime(650, t + 0.04);
    f.linearRampToValueAtTime(22000, t + dur);

    // Pitch wobble. Snap down fast (40ms), then ride back to 0 cents over
    // the rest of the duration — same shape as the volume duck so the ear
    // hears the three cues as one event, not three.
    const src = this.source;
    if (src) {
      const d = src.detune;
      d.cancelScheduledValues(t);
      d.setValueAtTime(d.value, t);
      d.linearRampToValueAtTime(-detuneCents, t + 0.04);
      d.linearRampToValueAtTime(0, t + dur);
    }
  }

  /**
   * Combo-milestone chime — a brief upward arpeggio (root → 5th → octave)
   * keyed off the lane palette so it sits in the same musical world as the
   * hit feedback. Volume scales softly with milestone index so 1000 doesn't
   * drown the song. Cheap (3-4 oscillators, ~280ms total).
   */
  playComboMilestone(milestone: number): void {
    if (!this.ctx || !this.sfxGain) return;
    if (!this.sfxOn) return;
    const t = this.ctx.currentTime;
    // Root in mid-range so the arpeggio sits above the song without
    // poking ears. C5 ≈ 523Hz.
    const root = 523.25;
    const intensity = Math.min(1, milestone / 500); // 25 → 0.05, 500+ → 1
    const baseVol = 0.18 + intensity * 0.18;
    this.pluck(t,         root,        0.32, baseVol,        "triangle");
    this.pluck(t + 0.06,  root * 1.5,  0.30, baseVol * 0.85, "triangle");
    this.pluck(t + 0.12,  root * 2,    0.36, baseVol * 0.95, "sine");
    if (intensity >= 0.6) {
      // Top sparkle for big milestones — Mario coin-streak energy.
      this.pluck(t + 0.18, root * 3, 0.22, baseVol * 0.65, "sine");
    }
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
    type: OscillatorType = "sine",
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
    // 10ms attack (was 5ms) — at 5ms the leading edge had a faint click
    // that the ear interpreted as a "tap" on top of the pluck. At 10ms
    // the attack is still well under one perception threshold (~20ms)
    // so it reads as instantaneous, but the click is gone.
    env.gain.linearRampToValueAtTime(vol, when + 0.01);
    env.gain.exponentialRampToValueAtTime(0.0001, when + dur);

    osc.connect(env).connect(this.sfxGain);
    osc.start(when);
    osc.stop(when + dur + 0.05);
  }
}
