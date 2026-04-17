# SYNCLE

A daily, brutalist rhythm game. One song per day. Hit notes to the beat,
hold the long ones, and chase your own best score. Tomorrow it&rsquo;s a
different track.

> **Status: v0.2** — single-player core loop is in, with hold notes,
> easy/normal/hard difficulty, and per-day local high scores.
> Multiplayer rooms (up to 50) and global daily leaderboards are next.

## Stack

- **Next.js 14 (App Router) + TypeScript** — UI shell, future API routes for scores/rooms.
- **Tailwind CSS** — brutalist dark theme with a single blue accent.
- **Web Audio API** — sample-accurate audio scheduling. Song time is read from `AudioContext.currentTime` so the chart locks to the audio clock, not requestAnimationFrame.
- **Canvas 2D** — perspective highway, falling notes, hold trails, hit feedback at 60fps.

This stack was picked because:
- it's all browser-native (no engine lock-in, easy to deploy on Vercel),
- audio timing is rock solid (the #1 thing that makes a rhythm game feel good or bad),
- adding online play later is a single Socket.IO/WS service away — game logic is already in pure TS modules (`lib/game/`).

## Run it

```bash
npm install
npm run dev
```

Then open http://localhost:3000 and hit **PLAY**.

## Controls

| Key                | Action                                |
| ------------------ | ------------------------------------- |
| `D` / `←`          | Lane 1 (red)                          |
| `F` / `↓`          | Lane 2 (yellow)                       |
| `J` / `↑`          | Lane 3 (green)                        |
| `K` / `→`          | Lane 4 (blue)                         |
| `M`                | Toggle metronome                      |

For **hold notes**: press the lane key on the head, keep it held while the
trail fills the gate, release on the tail. Releasing too early counts as a
miss for the tail.

Timing windows: ±60ms perfect, ±110ms great, ±160ms good, ±190ms miss.

## Difficulty

Three modes per song:

- **easy ★** — taps quantized to whole beats, max 1 tap per beat.
- **normal ★★** — taps quantized to half-beats, twice as dense.
- **hard ★★★** — the chart as the original osu! mapper made it.

Hold notes are kept in all modes (their head time is just snapped to the
grid on easy / normal so they stay aligned with the metronome).

## Daily best

You get one song per day, but you can play it as many times as you want —
only your highest score for that song + difficulty + day is saved. The
high score lives in `localStorage` under keys like:

```
syncle.best.<YYYY-MM-DD>.<songId>.<easy|normal|hard>
```

The day boundary is **midnight UTC**, matching the future daily-rotation
logic so everyone&rsquo;s clock rolls over together.

## Project layout

```
app/
  page.tsx            landing page (today's track + your best stat)
  play/page.tsx       full-screen game shell
components/
  Game.tsx            React + canvas integration, input, HUD, lifecycle
lib/game/
  types.ts            Note / Judgment / Stats / lane mapping (4 lanes)
  audio.ts            Web Audio engine wrapper (load + schedule + songTime)
  chart.ts            song metadata + procedural chart for "Love Gun"
  osu.ts              minimal .osu (osu!mania 4K) parser, taps + holds
  engine.ts           hit detection, hold tracking, scoring, combo, rock meter
  renderer.ts         canvas drawing — highway, notes, hold trails, popups
  best.ts             per-day localStorage high-score helpers
public/
  songs/today/        drop chart.osu + audio.mp3 here for the daily song
  songs/osu-mania/    dev-only osu! beatmap test set
```

## Adding a new song

The fastest way: drop the audio + chart into `public/songs/today/`.

1. Drop the audio file at `public/songs/today/audio.mp3`.
2. Drop the matching `.osu` (osu!mania 4K) chart at `public/songs/today/chart.osu`.

That slot has top priority in `lib/game/chart.ts → OSU_CANDIDATES`. If
nothing is there, the engine falls through to the dev test set in
`public/songs/osu-mania/`. There is no procedural fallback — without a
chart + audio pair, `loadSong()` rejects and the UI shows a "no chart
available" message.

Wiring an `id` into proper daily rotation across multiple songs is on
the roadmap below.

## Roadmap

- [ ] Daily rotation + UTC reset (track selection, not just score reset)
- [ ] Online leaderboard (Vercel KV / Postgres)
- [ ] Multiplayer rooms (Socket.IO, up to 50 players, race-style)
- [x] Hold notes (sustain)
- [x] Difficulty (easy / normal / hard)
- [x] Per-day local high score
- [ ] Calibration / audio offset slider
- [ ] More songs + chart authoring tool
