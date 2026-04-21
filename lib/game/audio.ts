import { Judgment } from "./types";

/**
 * Multiplier on the SFX bus relative to the song bus AT MASTER 100 %.
 * Below 100 % the SFX bus tracks the song bus under a loudness-
 * compensation curve (see `perceivedToSfxGain`) that progressively
 * boosts SFX as the master slider drops, so the music vs feedback
 * mix doesn't perceptually collapse at low volumes. 1.0 = no extra
 * attenuation at the top of the slider; the per-hit oscillator
 * amplitudes (in `playHit`, `playRelease`, `playEmptyPress`,
 * `playComboBreak`, `playComboMilestone`, `scheduleClick`) are the
 * only thing setting the SFX loudness ceiling at master = 100 %.
 * (`playMissDistort` adds no SFX; it only modulates the song bus.)
 * Those amplitudes were jointly trimmed -1 % in a final smoothing
 * pass so high-master hits don't feel disproportionately punchier
 * than low-master hits even after the loudness comp curve has done
 * its work — see `playHit` for the rationale.
 *
 * History — this value has been tuned three times to chase the right
 * music vs feedback balance:
 *   - 0.385 (≈ -8 dB)  : original "subordinate" mix. Combined with the
 *                        master limiter and conservative per-hit vols
 *                        (perfect=0.22, downbeat=0.18) this made hits
 *                        and metronome basically inaudible against any
 *                        normally-mastered song — players reported
 *                        "I can't tell when I hit a note" even at
 *                        100 % master. Peak SFX amp landed near 0.085
 *                        (-21 dB) under a song at 0 dBFS.
 *   - 0.65  (≈ -3.7 dB): first bump. Better, but still below the
 *                        practical noise floor of any loud song.
 *                        Players still couldn't hear hits when music
 *                        was playing.
 *   - 1.0   (this value): no bus-level attenuation. Per-source
 *                        peaks (perfect-hit drum ≈ 0.44 combined
 *                        noise+body, miss drum ≈ 0.56 combined,
 *                        metronome downbeat 0.41) now do all the
 *                        SFX-vs-song balancing on their own, landing
 *                        peak SFX around 41-56 % of song peak at
 *                        slider 1.0 — the same "punchy but never
 *                        on top of the song" feel osu! and friends
 *                        ship with. The combo-break cue runs slightly
 *                        hotter than hits because its low-frequency
 *                        sweep + sub layer gets masked by the song's
 *                        bass; see playComboBreak for the rationale.
 *                        (Per-note misses are now silent — only
 *                        breaking a streak ≥ 20 plays an audible cue.)
 *
 * Even at BASE_SFX_LEVEL = 1.0 the SFX bus stays NATURALLY below the
 * song peak because per-source peaks max out around 0.56 (constructive
 * sum of noise + body envelopes); the song buffer can hit 1.0 amp on a
 * loud master. That ~5-7 dB inherent headroom plus the master limiter
 * keeps combined peaks under 0 dBFS even when a perfect-tap drum, a
 * metronome downbeat and a song transient land on the same sample.
 *
 * The earliest design used a square-root taper on SFX while the song
 * used quadratic, intending to keep feedback "audible at low master".
 * In practice that inverted the mix below ~50 % slider — at 20 %
 * slider SFX ended up +14 dB OVER the song. Constant ratio (this
 * design) is the standard fix and is what most rhythm titles do when
 * they expose only one master slider (Celeste, etc. expose two; we
 * don't, so we bake the balance into the curves).
 */
const BASE_SFX_LEVEL = 1.0;

/**
 * Convert a slider/perceived value (0..1) to an actual GainNode value
 * for the SONG bus, using a quadratic ("audio taper") curve.
 *
 * Human loudness perception is roughly logarithmic in gain — a LINEAR
 * slider (`gain = slider`) feels like "nothing happens until 10%"
 * because:
 *   slider 0.50  →  -6 dB  ≈  70% as loud as full
 *   slider 0.10  →  -20 dB ≈  25% as loud
 *   slider 0.05  →  -26 dB ≈  18% as loud
 * The entire useful perceived range gets crammed into the bottom 10–15%
 * of the slider; the upper 85% all sounds like one indistinguishable
 * "loud" plateau. That's the dominant complaint with naive web-audio
 * volume sliders.
 *
 * Quadratic taper (`gain = perceived²`) is the standard "audio taper"
 * used in DAWs, mixers, and game engines (it's literally the
 * resistance curve audio-taper potentiometers use in hardware faders).
 * It maps:
 *   slider 0.80  →  -4 dB  ≈  76% perceived
 *   slider 0.50  →  -12 dB ≈  44% perceived
 *   slider 0.20  →  -28 dB ≈  13% perceived
 * — close to the player's intuition that "50% slider should sound like
 * about 50% volume". Endpoints stay anchored at silent (0) and full
 * (1) so the slider's two extremes do exactly what they say, and the
 * curve is monotonic across the whole range so every nudge produces
 * an audible step.
 *
 * Note: the value persisted in localStorage is the SLIDER value
 * (perceived 0..1), not the gain. The curve is applied inside the
 * engine, so the UI never has to know about it — and there's no
 * migration needed for existing saved values.
 */
function perceivedToGain(perceived: number): number {
  if (perceived <= 0) return 0;
  if (perceived >= 1) return 1;
  return perceived * perceived;
}

/**
 * SFX-bus gain compensation factor at very low master volumes
 * (slider → 0). Used by `perceivedToSfxGain` to multiply the SFX
 * bus's natural quadratic taper.
 *
 * At slider 1.0 the compensation is 1.0 (no boost) and the SFX bus
 * sits at the same gain as the song bus * BASE_SFX_LEVEL. As the
 * slider drops, compensation linearly rises toward `1 +
 * SFX_LOW_VOLUME_BOOST` — i.e. the SFX bus fades MORE SLOWLY than
 * the song bus, so the music vs SFX dB ratio shifts in feedback's
 * favour at quieter masters. Concrete dB ratio table (perfect-hit
 * drum combined peak ≈ 0.44 vs song peak 1.0):
 *   slider 1.00  →  44 % of song peak (-7.1 dB)
 *   slider 0.80  →  50 % of song peak (-6.0 dB)
 *   slider 0.50  →  60 % of song peak (-4.4 dB)
 *   slider 0.30  →  66 % of song peak (-3.6 dB)
 *   slider 0.10  →  73 % of song peak (-2.7 dB)
 *   slider 0.05  →  74 % of song peak (-2.6 dB)
 * For miss thuds (peak 0.55) the same table tops out around 93 %
 * at the lowest slider position — STILL below the song peak but
 * very close, which is fine: at 5 % master both are near the
 * noise floor anyway, and "more even at quiet volumes" is exactly
 * what the player asked for.
 *
 * Tuning history (was 0.7, now 0.78): the +0.08 bump adds ~3-5 %
 * more SFX gain at slider positions below 0.5 on top of the
 * across-the-board per-source +1 % bumps, addressing reports that
 * input feedback was still slightly under-leveled in the lower
 * half of the master slider. Bound stays well clear of the unity
 * inversion case (compensation max is 1.78, and the loudest
 * per-source peak is the miss thud at 0.55, so SFX bus peak at
 * slider → 0 caps around 0.55 × 1.78 = 0.98 — under, never above,
 * the song peak).
 */
const SFX_LOW_VOLUME_BOOST = 0.78;

/**
 * Convert a slider/perceived value (0..1) to an actual GainNode value
 * for the SFX bus. SFX uses the same quadratic taper as the song bus,
 * scaled by `BASE_SFX_LEVEL`, AND multiplied by a loudness
 * compensation factor that grows as the slider drops.
 *
 * Why not constant-ratio (the previous version): a constant dB offset
 * between SFX and song looked clean on paper but felt broken below
 * ~80 % slider in practice. Two compounding perceptual effects:
 *
 *   1. Fletcher-Munson — the ear's frequency response gets MUCH
 *      flatter at low SPL. A 140 Hz miss thud loses ~10-15 dB of
 *      perceived loudness when overall level drops 30-40 dB, while a
 *      song's vocals / snares (1-4 kHz, the ear's most sensitive
 *      band) lose much less. So as you turn the master down, the
 *      song "stays present" while low-frequency SFX falls into the
 *      ear's relatively deaf zone first.
 *   2. RMS masking by sustained content — a continuous loud-RMS
 *      signal (the song) masks short transient signals (hits) of
 *      similar level. The masking gets perceptually WORSE at lower
 *      SPL because the ear's adaptive gain re-anchors to whatever's
 *      loudest, leaving short transients further below the
 *      perception threshold than a pure dB calculation would predict.
 *
 * Loudness compensation (this version) addresses both: SFX bus
 * doesn't fade as fast as song bus, so the dB ratio shifts in SFX's
 * favour exactly when the perceptual problems get worst. The function
 * is bounded so SFX bus peak NEVER exceeds song bus peak at any
 * slider position (compensation max is `1 + SFX_LOW_VOLUME_BOOST` and
 * even the loudest per-source drum peak (miss ≈ 0.56) stays under
 * unity).
 *
 * The earliest design used `√perceived` on SFX vs `perceived²` on
 * song, which reached the inversion case at ~20 % slider (SFX +14 dB
 * over song). The bounded linear-comp here cannot reach that — by
 * construction SFX bus < song bus * (1 + boost) at every slider
 * position, and the boost is small enough (0.78) that even with the
 * hottest per-source drum (miss ≈ 0.56), the absolute SFX peak still
 * rounds to "even with song" at the lowest realistic master, never
 * above.
 */
function perceivedToSfxGain(perceived: number): number {
  if (perceived <= 0) return 0;
  if (perceived >= 1) return BASE_SFX_LEVEL;
  // Linear loudness compensation: factor = 1 at slider 1, grows to
  // (1 + boost) as slider → 0. Multiplied into the quadratic taper
  // so the curve is gentler at the low end without changing the top
  // of the slider where SFX is already audible.
  const compensation = 1 + SFX_LOW_VOLUME_BOOST * (1 - perceived);
  return BASE_SFX_LEVEL * perceived * perceived * compensation;
}

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
 *   - playHit(lane, judgment) — an atonal filtered-noise drum tap.
 *     Built off the empty-press recipe with two TINY ladders applied:
 *     a brightness lift (filter cutoff, capped at +2 % for "perfect")
 *     and a volume lift (capped at +5 % for "perfect", ≈ +0.42 dB).
 *     Both are deliberately minimal — successful hits sit a hair
 *     above empty without breaking the "same drum" timbre. ATONAL
 *     by design (noise, not oscillators) so it never clashes with
 *     the song's key. Judgment is communicated mostly visually
 *     (popups, score) plus this small audio delta for tactile
 *     reinforcement.
 *   - playRelease(lane, judgment) — same recipe as playHit (head and
 *     tail collapse into one timbral family). The player tells head
 *     and tail apart by gameplay context, not by sound.
 *   - playEmptyPress() — fires when the player taps a lane with no
 *     note in the hit window. A muted drum (lowpass noise + low body
 *     sine), no song duck — a soft acknowledgement that the input
 *     registered, intentionally not punitive.
 *   - playMissDistort() — Guitar-Hero-style song "choke" that fires
 *     on every missed note. NOT an SFX layer (per-miss SFX is silent);
 *     instead it routes through `duckSong` to briefly drop the song
 *     volume ~45 %, lowpass-roll the high band, and pitch-wobble
 *     ~30 cents over ~220 ms. Subtle but noticeable — the song
 *     itself acknowledges the whiff without slapping a separate
 *     sound on top of it. Recovers fast so consecutive misses don't
 *     turn the music into mud.
 *   - playComboBreak() — the only miss-adjacent SFX layer. Per-note misses
 *     are SILENT now; this dedicated cue fires once when a streak of
 *     ≥ COMBO_BREAK_THRESHOLD (20) is broken. Level-edge triggered
 *     from `state.stats.comboBreaks` in the game loop. Three-layer
 *     synthesis (sub-thump + highpass noise burst + descending
 *     sawtooth sweep) with an aggressive song duck (deeper / longer
 *     than the old per-miss duck) — distinct, slightly jarring, and
 *     impossible to miss against any song. Mirrors osu!'s combobreak
 *     convention so streak losses feel like moments, not noise.
 *   - playComboMilestone(milestone) — a brief tonal arpeggio (the one
 *     intentional musical cue, since milestones are rewards not
 *     input feedback).
 *   - scheduleClick(beatTime, downbeat) — a metronome tick scheduled at a
 *     specific AudioContext time. Used to verify rhythm sync.
 *
 * Signal graph:
 *   source → songFilter (lowpass) → songGain → master → limiter → destination
 *   sfx    → sfxGain → master → limiter → destination
 *
 * Master volume routes BOTH buses through curves of the same shape
 * (quadratic) but the SFX bus also gets a loudness-compensation
 * multiplier that grows as the slider drops:
 *   songGain.gain = perceivedToGain(songVol)            // perceived²
 *   sfxGain.gain  = perceivedToSfxGain(songVol)
 *                 // = perceived² * (1 + 0.78 * (1 - perceived))
 *
 * At slider 1.0 the SFX bus matches the song bus; as the slider
 * drops, SFX fades MORE SLOWLY than song so the music-vs-feedback dB
 * ratio shifts in feedback's favour (compensating for the ear's
 * reduced low-frequency sensitivity at low SPL — Fletcher-Munson).
 * The function is bounded so SFX bus peak never exceeds song bus
 * peak at any slider position. The actual mix balance — why SFX
 * never overpowers the song even with the boost — lives in the
 * per-source drum peaks (which max around 0.44-0.56) being
 * smaller than the song buffer's typical 1.0 peak. See
 * `perceivedToSfxGain` for the full rationale (including the older
 * constant-ratio design that left low-volume SFX inaudible, and the
 * even-older square-root SFX curve that inverted the mix).
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
  /**
   * Cached white-noise AudioBuffer reused by every drum-style SFX
   * (`playHit`, `playRelease`, `playEmptyPress`, the noise-burst layer
   * inside `playComboBreak`). Generated lazily on first need and held
   * for the lifetime of the context — one ~400 ms mono buffer is ~70 KB
   * at 44.1 kHz, negligible. Reusing the same buffer means filter +
   * envelope variations are what differentiate the cues, not different
   * noise source allocations per call.
   */
  private noiseBuf: AudioBuffer | null = null;

  /** AudioContext.currentTime at which the song's t=0 lines up. */
  private startedAtCtxTime = 0;
  private playing = false;
  private duration_ = 0;
  private songVol = 0.85;

  private metronomeOn = false;
  /**
   * When false, suppress the "Feedback" SFX bus (hit pluck, miss thud,
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

      // Soft-knee limiter close to 0 dBFS. It rarely triggers during
      // normal play but absorbs the brief peaks when a perfect-tap
      // pluck stacks on top of a metronome click + a high-velocity
      // drum from the song. Without this, those transients clip on
      // Chrome's default destination and you hear a tiny crackle.
      //
      // Tuning notes (was threshold -2 dB, ratio 8:1, knee 6 dB):
      //   - threshold raised to -1 dB so the song bus (which can sit
      //     near 0 dBFS at slider 1.0) doesn't constantly push into
      //     compression. We only want gain reduction during true SFX
      //     spikes, not on every loud chorus chord.
      //   - ratio dropped to 6:1 so the SFX transients that DO push
      //     past threshold still get most of their energy through —
      //     the previous 8:1 was crushing them flat (the user could
      //     not hear hits or metronome at high song volumes).
      //   - knee tightened to 5 dB so the curve below threshold stays
      //     genuinely linear. The combo of "near-0 threshold +
      //     softer ratio + tighter knee" preserves SFX punch while
      //     still catching the rare clip-risk overshoot.
      this.limiter = this.ctx!.createDynamicsCompressor();
      this.limiter.threshold.value = -1;   // dB
      this.limiter.knee.value = 5;
      this.limiter.ratio.value = 6;
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
      // setVolume() call lands — already respects their slider AND
      // the loudness-compensated SFX-vs-song bus ratio baked into
      // perceivedToSfxGain.
      this.sfxGain.gain.value = perceivedToSfxGain(this.songVol);
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
    // Pay every "first time" SFX cost during the silent lead-in instead
    // of at the moment the player taps the first note. Does the 17K-
    // sample noise-buffer build, JIT-compiles playDrum / scheduleClick /
    // the miss-sawtooth path, and warms up Web Audio's worker pool so
    // the first audible interaction doesn't pay any of those overheads
    // synchronously on the audio thread (which previously surfaced as a
    // small visual stutter at song onset).
    this.prewarmSfx();
    // `volume` is the slider/perceived value (0..1); the actual GainNode
    // value goes through perceivedToGain() so 50% slider really sounds
    // like ~50% loudness. We store the perceived form on songVol so any
    // later code that reads it (duckSong, setVolume) sees the same
    // mental model.
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
    gain.gain.linearRampToValueAtTime(perceivedToGain(volume), startAt + fadeLen);

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

  /**
   * Set the master volume.
   *
   * `v` is the SLIDER position (perceived 0..1), not the raw gain. The
   * engine routes it through `perceivedToGain()` so the slider feels
   * even from top to bottom (50% slider ≈ 50% loudness, not 75% as a
   * naive linear gain would produce). The persisted value is the
   * slider position, so the curve is purely an internal concern — the
   * UI keeps showing 0–100%.
   */
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
      // Both buses share the same quadratic shape (BASE_SFX_LEVEL =
      // 1.0 means SFX bus tracks song bus 1:1 at slider 1.0); the SFX
      // bus also picks up a loudness-compensation multiplier that
      // gently boosts SFX as the slider drops, so the music vs
      // feedback mix doesn't perceptually collapse below ~80 % — see
      // perceivedToSfxGain doc for the dB table and the rationale for
      // moving away from the previous square-root SFX curve (which
      // overcorrected and made SFX dominate at low volumes).
      const songGainTarget = perceivedToGain(clamped);
      const sfxGainTarget = perceivedToSfxGain(clamped);
      if (this.songGain) {
        const g = this.songGain.gain;
        g.cancelScheduledValues(t);
        g.setValueAtTime(g.value, t);
        g.linearRampToValueAtTime(songGainTarget, t + 0.05);
      }
      if (this.sfxGain) {
        const g = this.sfxGain.gain;
        g.cancelScheduledValues(t);
        g.setValueAtTime(g.value, t);
        g.linearRampToValueAtTime(sfxGainTarget, t + 0.05);
      }
    }
  }

  setMetronome(on: boolean): void {
    this.metronomeOn = on;
  }

  /**
   * Master switch for the "Feedback" SFX bus. Mirrors `setMetronome` —
   * the engine still functions normally, the gated `playHit` /
   * `playEmptyPress` / `playRelease` / `playComboBreak` /
   * `playComboMilestone` calls just no-op. Cheap,
   * stateless, safe to flip mid-song.
   */
  setSfx(on: boolean): void {
    this.sfxOn = on;
  }

  // ---------------------------------------------------------------------
  // Gameplay feedback
  // ---------------------------------------------------------------------

  /**
   * Successful-hit feedback — a bright atonal drum tap.
   *
   * Why drums (filtered noise) instead of pluck oscillators:
   *   1. Atonal — has no defined fundamental, so it CAN'T clash with
   *      the song's key (the previous lane-pitched sine plucks would
   *      land out-of-key on songs in F# or Bb minor and read as
   *      "wrong notes").
   *   2. Percussive timbre matches the action — pressing a key is a
   *      physical tap; a filtered noise transient reads as that tap.
   *
   * Filter choice — LOWPASS (not highpass): a HIGHPASS at 4-5 kHz
   * removes everything BELOW the cutoff, leaving only the
   * high-frequency sizzle band where hi-hats and cymbals live —
   * which made the previous revision sound like a hi-hat, not a
   * drum. A real drum has BODY (60-300 Hz) plus a stick attack
   * (mids + some highs). LOWPASS at a high cutoff (3-5 kHz) keeps
   * the body and most of the stick attack while rolling off the
   * cymbal-sizzle band — textbook snare drum spectrum. Pair it
   * with a low body sine that bends down (the "drum body" thump)
   * and you get a coherent drum-kit hit.
   *
   * Per-judgment differentiation (still NO pitch — purely timbral):
   *   perfect : bright snare-drum hit (lowpass 5.5 kHz keeps a lot
   *             of stick attack) + firm body thump. Snappy.
   *   great   : warmer drum (lowpass 4.5 kHz, less sizzle through)
   *             + medium body. Firm.
   *   good    : softer drum (lowpass 3.5 kHz, body-dominant)
   *             + light body. Pad-like.
   *
   * Hits vs empty press differentiation:
   *   - Empty press lowpass cutoff is ~800 Hz (truly muffled, only
   *     sub + low-mids through — felt mallet on a damped pad).
   *   - Hit cutoffs are 3.5-5.5 kHz (full drum spectrum through).
   *   That ~5x cutoff ratio is what reads as "brighter" vs "muffled"
   *   while keeping both squarely in drum-kit territory.
   *
   * Subtle lane offset (~±300 Hz spread) on the lowpass cutoff so
   * a stream of D-D-J-J taps feels textured rather than monotonous,
   * without ever introducing a defined pitch.
   *
   * Volume targets: combined output peak ~0.50 / 0.40 / 0.30 for
   * perfect / great / good. Lowpass at high cutoff passes ~25-30 %
   * of the noise spectrum, so output noise peak ≈ noiseVol * 0.5;
   * combined with the body sine (full amplitude), total constructive
   * peak lands at the targets above. Loudness-compensation curve
   * and dB-vs-song-peak tables remain valid.
   */
  playHit(lane: number, judgment: Judgment): void {
    if (!this.ctx || !this.sfxGain) return;
    if (!this.sfxOn) return;
    const t = this.ctx.currentTime;
    this.playInputFeedback(lane, judgment, t);
  }

  /**
   * Hold-tail release feedback. Shares `playInputFeedback` with
   * `playHit` so head and tail collapse into one timbral family —
   * the player tells them apart by gameplay context (they know
   * they're releasing), not by a separate sound. Real-miss tails
   * still get the descending sawtooth thud, identical to a
   * missed head.
   */
  playRelease(lane: number, judgment: Judgment): void {
    if (!this.ctx || !this.sfxGain) return;
    if (!this.sfxOn) return;
    if (judgment === "miss") {
      // A missed tail behaves like a head miss for audio purposes:
      // SILENT individually. The engine's `tallyJudgment("miss")`
      // already incremented `state.stats.comboBreaks` if this broke
      // a streak ≥ 20, and the render loop's combo-break watcher
      // will fire `playComboBreak()` on the next frame.
      return;
    }
    const t = this.ctx.currentTime;
    this.playInputFeedback(lane, judgment, t);
  }

  /**
   * Shared input-feedback routine for head hits and hold-tail
   * releases. Reuses the empty-press recipe with a tiny brightness
   * lift AND a tiny volume lift per judgment — both capped small
   * enough that the entire hit + release family still reads as
   * "same drum as empty, just barely more present when you connect".
   *
   * Brightness ladder (filter cutoff vs empty's 800 Hz):
   *   good     → +0.6 %  (805 Hz)
   *   great    → +1.25 % (810 Hz)
   *   perfect  → +2 %    (816 Hz)
   * Body frequency tracks the same envelope (140 → ~143 Hz at
   * perfect) so the body and noise stay phase-coherent.
   *
   * Volume ladder (multiplier on empty's noiseVol/bodyVol):
   *   empty    → 1.000  (0.566 noise, 0.212 body — reference)
   *   good     → 1.015  (+1.5 %)
   *   great    → 1.030  (+3 %)
   *   perfect  → 1.050  (+5 %)
   * That's roughly +0.13 dB / +0.26 dB / +0.42 dB perceived — the
   * SMALLEST step that's still audible against an actively-playing
   * song. Below ~+1.5 % the difference disappears under any music
   * bed; above ~+5 % the family stops reading as "the same sound"
   * and starts reading as a louder hit drum on top of the empty
   * drum, which the user explicitly wanted to avoid.
   *
   * Lane offset stays tiny (±6 Hz on the cutoff, well under 1 %)
   * so each lane gets a hair of texture variation without breaking
   * the "same drum" rule.
   */
  private playInputFeedback(
    lane: number,
    judgment: Judgment,
    when: number,
  ): void {
    const laneOffset = (lane - 1.5) * 4;
    let cutoffBumpHz: number;
    let bodyBumpHz: number;
    let volMul: number;
    if (judgment === "perfect") {
      cutoffBumpHz = 16;
      bodyBumpHz = 3;
      volMul = 1.05;
    } else if (judgment === "great") {
      cutoffBumpHz = 10;
      bodyBumpHz = 2;
      volMul = 1.03;
    } else {
      cutoffBumpHz = 5;
      bodyBumpHz = 1;
      volMul = 1.015;
    }
    this.playDrum({
      when,
      filterType: "lowpass",
      filterHz: 800 + cutoffBumpHz + laneOffset,
      filterQ: 0.7,
      noiseVol: 0.566 * volMul,
      dur: 0.09,
      bodyHz: 140 + bodyBumpHz,
      bodyVol: 0.212 * volMul,
      bodyDur: 0.08,
    });
  }

  /**
   * Per-miss song distort — the Guitar-Hero-style "guitar choke" cue
   * that fires on EVERY missed note (not just combo breaks). The
   * actual SFX layer for individual misses is silent by design (see
   * `playComboBreak` for the streak-loss cue), so this is the only
   * audio feedback for a routine miss. Three light cues stacked:
   *
   *   - 45 % volume dip (vs the old 64 % per-miss dip — was tuned
   *     to pair with a loud descending-sawtooth SFX that no longer
   *     exists; without that SFX a deeper dip felt aggressive)
   *   - ~650 Hz lowpass roll-off (muffles the song's high band for
   *     a beat — reads as "the song just wobbled")
   *   - 30-cent pitch wobble (≈ 1/3 of a semitone — audibly off,
   *     well short of "broken")
   *
   * Recovery in 220 ms so consecutive misses don't drag the song
   * into mud. `duckSong` cancels + re-schedules its ramps each call,
   * so back-to-back misses just keep extending the dip — which is
   * the right behaviour: if the player is actively whiffing, the
   * song staying choked makes semantic sense.
   *
   * Gated by `sfxOn` so the Feedback toggle kills it cleanly.
   */
  playMissDistort(): void {
    if (!this.sfxOn) return;
    this.duckSong(0.55, 220, 30);
  }

  /**
   * Empty-press feedback — fires when the player taps a lane that
   * has no note within the hit window. A MUTED drum: soft mid-low
   * body sine (~140 Hz) plus a lowpass-noise tail (~800 Hz) for
   * "padded surface" texture. No song duck — an empty tap is
   * acknowledgement, not punishment. Combined peak ~0.32.
   *
   * Note: per-note misses are now SILENT by design. The dedicated
   * `playComboBreak()` cue fires (level-edge triggered from
   * `state.stats.comboBreaks`) when a streak of ≥ 20 ends. Routine
   * 1-19 misses get only the visual popup — matches osu! convention.
   */
  playEmptyPress(): void {
    if (!this.ctx || !this.sfxGain) return;
    if (!this.sfxOn) return;
    const t = this.ctx.currentTime;
    this.playDrum({
      when: t,
      filterType: "lowpass",
      filterHz: 800,
      filterQ: 0.7,
      noiseVol: 0.566,
      dur: 0.09,
      bodyHz: 140,
      bodyVol: 0.212,
      bodyDur: 0.08,
    });
  }

  /**
   * Combo-break feedback — the only audible cue tied to losing a
   * streak. Fires from the render loop when `state.stats.comboBreaks`
   * advances (i.e., a miss/early-release just zeroed a combo of ≥ 20).
   *
   * Designed to be DISTINCT and slightly jarring — three layered
   * elements wider/sharper than any other in-game SFX so the player
   * registers "you broke it" without ambiguity:
   *
   *   1. Sub-thump (sine ~80 Hz, ~70 ms): low-end weight on the front
   *      so the cue lands physically before the eye sees the popup.
   *   2. Noise burst (highpass ~3 kHz, ~50 ms): sharp "shatter" snap
   *      that occupies the upper band — distinct from the lowpass
   *      noise that powers all other input feedback, which is what
   *      makes it cut through the mix.
   *   3. Descending sawtooth (300 → 70 Hz over 200 ms, lowpass 800 Hz):
   *      the "deflation" sweep, wider and lower than the original
   *      per-miss saw so it reads as "moment ended", not "small whiff".
   *
   * Plus an aggressive `duckSong` (deeper drop, longer recovery, more
   * pitch wobble than the old per-miss duck) so the SONG itself
   * acknowledges the break for ~380 ms. The whole event totals about
   * 0.4 s of audible material before the song fully recovers.
   */
  playComboBreak(): void {
    if (!this.ctx || !this.sfxGain) return;
    if (!this.sfxOn) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    // Layer 1 — sub-thump.
    {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(80, t);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(0.42, t + 0.005);
      env.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
      osc.connect(env).connect(this.sfxGain);
      osc.start(t);
      osc.stop(t + 0.08);
    }

    // Layer 2 — sharp highpass noise burst. Reuses the shared
    // noise buffer (cached + prewarmed) and slams it through a
    // highpass so it sits in the 3-8 kHz band — a region none of
    // the input-feedback drums occupy, which is exactly what makes
    // it punch through.
    {
      const buf = this.getNoiseBuffer();
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const filt = ctx.createBiquadFilter();
      filt.type = "highpass";
      filt.frequency.value = 3000;
      filt.Q.value = 0.7;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(0.55, t + 0.003);
      env.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
      src.connect(filt).connect(env).connect(this.sfxGain);
      src.start(t);
      src.stop(t + 0.06);
    }

    // Layer 3 — descending sawtooth. Wider sweep than the old
    // per-miss saw (300 → 70 Hz vs 140 → 55) so the "deflation"
    // arc reads bigger.
    {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(300, t);
      osc.frequency.exponentialRampToValueAtTime(70, t + 0.20);
      const filt = ctx.createBiquadFilter();
      filt.type = "lowpass";
      filt.frequency.value = 800;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(0.50, t + 0.005);
      env.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
      osc.connect(filt).connect(env).connect(this.sfxGain);
      osc.start(t);
      osc.stop(t + 0.26);
    }

    // Aggressive song duck — deeper / longer / more wobble than the
    // old per-miss duck because this only fires on actual moments,
    // and the song should momentarily acknowledge the break.
    this.duckSong(0.25, 380, 90);
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
    // `songVol` is the perceived/slider value; the actual gain we want
    // to dip from (and recover back to) is the curved value. Multiplying
    // amountFactor against the curved gain keeps the duck depth a true
    // 36% of the running level, regardless of where the slider sits.
    const vol = perceivedToGain(this.songVol);

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
    // baseVol sized to sit at the same perceptual loudness as the
    // hit drums (0.44 combined peak) so the milestone arpeggio reads
    // as "celebration on top of hit feedback" instead of getting
    // buried under the song. Spread between low (0.328) and high
    // (0.558) keeps the 25-combo cue tasteful while letting the
    // 500+ chime feel earned. Intentionally tonal (unlike the atonal
    // input-feedback drums) because milestones are REWARDS, not
    // input acknowledgements — a melodic flourish reads as
    // "achievement" the way a percussive tap reads as "input".
    const baseVol = 0.328 + intensity * 0.23;
    this.pluck(t,         root,        0.32, baseVol,        "triangle");
    this.pluck(t + 0.06,  root * 1.5,  0.30, baseVol * 0.85, "triangle");
    this.pluck(t + 0.12,  root * 2,    0.36, baseVol * 0.95, "sine");
    if (intensity >= 0.6) {
      // Top sparkle for big milestones — Mario coin-streak energy.
      this.pluck(t + 0.18, root * 3, 0.22, baseVol * 0.65, "sine");
    }
  }

  /**
   * Schedule a metronome click at a given AudioContext time.
   *
   * Click peaks (downbeat 0.41 / upbeat 0.227) sit at roughly the same
   * perceptual loudness as the bright top end of a hit drum so a
   * player who relies on the metronome to follow rhythm hears it at
   * a similar level to their own hit feedback — a coherent
   * "tick / tap / tick / tap" mix. The metronome is high-frequency
   * (1000–1500 Hz) and very short (~60 ms), so even at this peak it
   * doesn't dominate the song — the human ear hears the tick as a
   * clean, isolated rhythmic cue thanks to its narrow time +
   * frequency footprint.
   *
   * Why a tonal sine here (vs the atonal noise drums for input
   * feedback): a metronome's whole job is to be a clean, easily
   * trackable PULSE. A pitched click at a fixed octave is the
   * canonical way to do that across every metronome ever shipped.
   * Switching to noise here would make the rhythmic anchor harder
   * to lock onto, which is the opposite of what the metronome is
   * for. The pitch (1000/1500 Hz) is high enough that it can't
   * clash with any song's harmonic content the way the old
   * lane-pitched plucks could.
   *
   * History (was 0.18/0.09, then 0.30/0.16, now 0.41/0.227): each
   * bump was driven by reports of the metronome being inaudible
   * during normally-mastered songs even at slider 1.0. With
   * BASE_SFX_LEVEL now at 1.0 (no bus-level attenuation), this is
   * the level that actually clears the music's RMS noise floor at
   * every master volume the player is realistically going to use.
   */
  scheduleClick(when: number, downbeat: boolean): void {
    if (!this.ctx || !this.sfxGain || !this.metronomeOn) return;
    const osc = this.ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = downbeat ? 1500 : 1000;

    const env = this.ctx.createGain();
    const peak = downbeat ? 0.41 : 0.227;
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(peak, when + 0.002);
    env.gain.exponentialRampToValueAtTime(0.0001, when + 0.06);

    osc.connect(env).connect(this.sfxGain);
    osc.start(when);
    osc.stop(when + 0.1);
  }

  // ---------------------------------------------------------------------

  /**
   * Lazily generate (and cache) a short white-noise AudioBuffer used
   * by every drum-style SFX. 400 ms is plenty: the longest drum
   * envelope in this engine (a real miss) is ~180 ms. Reused across
   * every `playDrum` call — the buffer source itself is cheap, the
   * buffer allocation is the part we want to do exactly once.
   */
  private getNoiseBuffer(): AudioBuffer | null {
    if (!this.ctx) return null;
    if (this.noiseBuf) return this.noiseBuf;
    const dur = 0.4;
    const buf = this.ctx.createBuffer(1, Math.floor(this.ctx.sampleRate * dur), this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
    return buf;
  }

  /**
   * Generic drum-style SFX: a filtered noise burst, with an optional
   * low-sine "body" layered underneath for kick/snap energy.
   *
   * Atonal by construction — noise has no defined fundamental, and
   * the optional body sine bends DOWN so it reads as percussive
   * impact rather than a held tone. Used by `playHit`, `playRelease`,
   * and `playEmptyPress` to give the whole input-feedback family a
   * coherent drum-kit timbre. (`playComboBreak` builds its own graph
   * inline because it layers a sub-thump + highpass noise burst
   * + descending sawtooth that don't match the `playDrum` recipe.)
   *
   * Filter choice matters a LOT for audibility:
   *   - "highpass" — passes ~70-80 % of the noise spectrum (everything
   *     above the cutoff). Output peak ≈ noiseVol * 0.85, very close
   *     to the requested level. Best for HITS and SNARE-LIKE CRACKS
   *     where you want a bright, broadband transient.
   *   - "lowpass" — passes only the band below the cutoff. At 800 Hz
   *     cutoff that's 4 % of the audible bandwidth, so output peak
   *     is just ~20 % of noiseVol. Best for MUTED THUMPS where the
   *     point is filtered/dampened character; needs noiseVol ~0.5+
   *     to be audible, and pairs naturally with a body sine that
   *     carries the actual loudness.
   *   - "bandpass" — narrowest, attenuates most. Output peak ≈
   *     noiseVol * 0.10-0.15 at Q ≈ 1.4. Avoid for primary cues; it
   *     was the cause of the first drum revision being inaudible.
   *
   * Tuning notes:
   *   - `filterHz` is the dominant character knob. For highpass:
   *     higher cutoff = thinner / brighter; lower = thicker / warmer.
   *     For lowpass: higher cutoff = brighter; lower = duller.
   *   - `filterQ` defaults to 0.707 (Butterworth, no resonant peak).
   *     Past ~3 a bandpass / lowpass starts ringing audibly which
   *     reads as a pitch — defeats the "atonal" goal.
   *   - `bodyHz` + `bodyVol` + `bodyDur` add a low sine that
   *     pitch-bends DOWN to half its starting freq, reading as a
   *     kick impact. Skip all three to get a pure noise tap.
   *   - All envelopes use a 2 ms linear attack + exponential decay,
   *     same shape across every variant so the "tap rhythm" reads
   *     consistently — only the spectrum changes between hit /
   *     empty / miss.
   */
  private playDrum(opts: {
    when: number;
    filterType?: BiquadFilterType;
    filterHz: number;
    filterQ?: number;
    noiseVol: number;
    dur: number;
    bodyHz?: number;
    bodyVol?: number;
    bodyDur?: number;
  }): void {
    if (!this.ctx || !this.sfxGain) return;
    const buf = this.getNoiseBuffer();
    if (!buf) return;
    const ctx = this.ctx;
    const t = opts.when;
    const ftype = opts.filterType ?? "highpass";
    const fq = opts.filterQ ?? 0.707;

    // Filtered noise tap.
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filt = ctx.createBiquadFilter();
    filt.type = ftype;
    filt.frequency.value = opts.filterHz;
    filt.Q.value = fq;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(opts.noiseVol, t + 0.002);
    env.gain.exponentialRampToValueAtTime(0.0001, t + opts.dur);
    src.connect(filt).connect(env).connect(this.sfxGain);
    src.start(t);
    src.stop(t + opts.dur + 0.05);

    // Optional low body for kick/snap energy.
    if (opts.bodyHz && opts.bodyVol && opts.bodyDur) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(opts.bodyHz, t);
      osc.frequency.exponentialRampToValueAtTime(opts.bodyHz * 0.5, t + opts.bodyDur);
      const benv = ctx.createGain();
      benv.gain.setValueAtTime(0, t);
      benv.gain.linearRampToValueAtTime(opts.bodyVol, t + 0.002);
      benv.gain.exponentialRampToValueAtTime(0.0001, t + opts.bodyDur);
      osc.connect(benv).connect(this.sfxGain);
      osc.start(t);
      osc.stop(t + opts.bodyDur + 0.05);
    }
  }

  /**
   * One-time SFX warm-up. Builds the noise buffer eagerly (so the
   * first `playDrum` doesn't pay a 17K-sample `Math.random()` loop
   * synchronously) and schedules an inaudible dry-run of EVERY SFX
   * code path so V8 has JIT-compiled them and Web Audio has the
   * underlying worker graph alive before the first audible cue.
   *
   * "Inaudible" here means peak gain ≈ 1e-4 (~ -80 dB), well below
   * the noise floor at any reasonable master volume. The audio thread
   * still walks the full node graph and pays the one-time scheduling
   * cost, but the user never hears it. Critically: this runs DURING
   * `start()`, which is itself invoked at the front of the 8s pre-
   * countdown — by the time the song is actually audible the JIT is
   * hot, the noise buffer is cached, and Web Audio's worker pool
   * has the relevant DSP units instantiated.
   *
   * Coverage matrix — every public play* method should map to at
   * least one block here. If you add a new SFX path, add a dry-run.
   *
   *   playHit / playRelease / playEmptyPress  → block (a)
   *   playComboBreak (sub layer)              → block (b)
   *   playComboBreak (noise burst layer)      → block (c)
   *   playComboBreak (sawtooth sweep layer)   → block (d)
   *   playMissDistort + playComboBreak duck   → block (e) [JITs
   *     `duckSong`'s gain/filter/detune automations on throwaway
   *     nodes — without this the first miss pays the cost live]
   *   scheduleClick (metronome)               → block (f)
   *   playComboMilestone (pluck arpeggio)     → block (g)
   *
   * Idempotent: subsequent `start()` calls re-pay the dry-run cost
   * (it's microseconds, all on the audio thread) but the noise
   * buffer survives.
   */
  private prewarmSfx(): void {
    if (!this.ctx || !this.sfxGain) return;
    // Force the lazy noise buffer NOW so the first real `playDrum`
    // call (almost certainly the player's first tap) doesn't have
    // to build it on the spot.
    this.getNoiseBuffer();

    const ctx = this.ctx;
    const t = ctx.currentTime + 0.001;

    // ---- (a) Hit / release / empty press ----
    // Exercises createBufferSource + createBiquadFilter("lowpass" /
    // "highpass") + createGain envelope + optional body sine, all
    // wired through `sfxGain`. Two passes (lowpass, highpass) so
    // both filter modes JIT.
    this.playDrum({
      when: t,
      filterType: "lowpass",
      filterHz: 5000,
      noiseVol: 0.0001,
      dur: 0.005,
      bodyHz: 220,
      bodyVol: 0.0001,
      bodyDur: 0.005,
    });
    this.playDrum({
      when: t,
      filterType: "highpass",
      filterHz: 4500,
      noiseVol: 0.0001,
      dur: 0.005,
    });

    // ---- (b) Combo-break sub-thump (80 Hz sine, fast decay) ----
    // Same graph as the sub layer in `playComboBreak`. Sine + gain
    // envelope is structurally similar to the metronome click, but
    // at a very different frequency (80 vs 1500 Hz) — JIT for
    // BiquadFilter-less sine paths is shared, so this is mostly
    // about exercising Web Audio's low-frequency oscillator pool.
    {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(80, t);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(0.0001, t + 0.002);
      env.gain.exponentialRampToValueAtTime(0.00001, t + 0.007);
      osc.connect(env).connect(this.sfxGain);
      osc.start(t);
      osc.stop(t + 0.01);
    }

    // ---- (c) Combo-break noise burst (highpass, ~3 kHz) ----
    // Already covered structurally by playDrum highpass in (a),
    // but the production graph in `playComboBreak` builds the
    // BufferSource + BiquadFilter inline rather than via playDrum.
    // We mirror that exact graph shape so the inline path is hot.
    {
      const buf = this.getNoiseBuffer();
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const filt = ctx.createBiquadFilter();
      filt.type = "highpass";
      filt.frequency.value = 3000;
      filt.Q.value = 0.7;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(0.0001, t + 0.002);
      env.gain.exponentialRampToValueAtTime(0.00001, t + 0.007);
      src.connect(filt).connect(env).connect(this.sfxGain);
      src.start(t);
      src.stop(t + 0.01);
    }

    // ---- (d) Combo-break descending sawtooth ----
    // Same shape as the sweep layer in `playComboBreak`. Sawtooth
    // + lowpass + envelope is its own JIT path (distinct from
    // playDrum's BufferSource graph).
    {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(300, t);
      osc.frequency.exponentialRampToValueAtTime(70, t + 0.005);
      const filt = ctx.createBiquadFilter();
      filt.type = "lowpass";
      filt.frequency.value = 800;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(0.0001, t + 0.001);
      env.gain.exponentialRampToValueAtTime(0.00001, t + 0.005);
      osc.connect(filt).connect(env).connect(this.sfxGain);
      osc.start(t);
      osc.stop(t + 0.01);
    }

    // ---- (e) Song-duck automation (playMissDistort + comboBreak duck) ----
    // `duckSong` calls `cancelScheduledValues` + `setValueAtTime` +
    // `linearRampToValueAtTime` on songGain.gain, songFilter.frequency
    // and source.detune. Those parameter automations have their own
    // V8 JIT paths and Web Audio scheduling code. We can't run them
    // on the LIVE song bus during prewarm (it would clobber the
    // pending fade-in); instead we build throwaway Gain + Biquad +
    // BufferSource nodes (NEVER connected, NEVER started, just held
    // long enough for the automations to compile) and run the same
    // API calls on them. JIT is per-method, not per-instance, so
    // this hot-paths the production duckSong call.
    {
      const fakeGain = ctx.createGain();
      const g = fakeGain.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(0.0001, t + 0.002);
      g.linearRampToValueAtTime(g.value, t + 0.005);

      const fakeFilt = ctx.createBiquadFilter();
      fakeFilt.type = "lowpass";
      const f = fakeFilt.frequency;
      f.cancelScheduledValues(t);
      f.setValueAtTime(f.value, t);
      f.linearRampToValueAtTime(650, t + 0.002);
      f.linearRampToValueAtTime(22000, t + 0.005);

      const fakeSrc = ctx.createBufferSource();
      fakeSrc.buffer = this.getNoiseBuffer();
      const d = fakeSrc.detune;
      d.cancelScheduledValues(t);
      d.setValueAtTime(d.value, t);
      d.linearRampToValueAtTime(-30, t + 0.002);
      d.linearRampToValueAtTime(0, t + 0.005);
      // fakeSrc is never started; it just exists so V8 binds the
      // detune AudioParam methods to a real BufferSource instance.
    }

    // ---- (f) Metronome click ----
    // Sine osc + envelope, no filter. The first audible click
    // hits the first beat past songTime = 0; without this warmup
    // that very first click would JIT live on the audio thread.
    {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = 1500;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(0.0001, t + 0.001);
      env.gain.exponentialRampToValueAtTime(0.00001, t + 0.005);
      osc.connect(env).connect(this.sfxGain);
      osc.start(t);
      osc.stop(t + 0.01);
    }

    // ---- (g) Combo-milestone arpeggio (pluck graph) ----
    // `playComboMilestone` calls `pluck()` 3-4 times per milestone
    // with different freqs / types. The pluck graph is sine osc +
    // exponential frequency droop + gain envelope — distinct from
    // (b) and (f) because the OSC frequency itself is automated.
    // Warm one pass at near-zero volume; subsequent milestones
    // (25 / 50 / 100 / ...) reuse the same JIT'd machinery.
    this.pluck(t, 440, 0.005, 0.0001, "sine");
  }

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
