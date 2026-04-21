# SYNCLE

4K rhythm game. Random song. Endless retries.

> **Status: v0.3** — single-player + multiplayer rooms (Socket.IO).

## Stack

Next.js 14 (App Router) · React 18 · TypeScript 5 · Tailwind CSS 3 ·
Web Audio API · Canvas 2D · Socket.IO 4.

## Run it

```bash
npm install
npm run dev
```

Opens on http://localhost:3000. `npm run dev` runs Next.js + the
Socket.IO server on the same port via a custom `tsx watch server.ts`
— no separate compile step.

For a production-style local run:

```bash
npm run build
npm start
```

The recommended deploy is **Vercel** (Next.js) + **Render** (Socket.IO
service) — see `render.yaml` and `vercel.json` for the wiring.

## Controls

| Key            | Action                       |
| -------------- | ---------------------------- |
| `D` / `←`      | Lane 1 (red)                 |
| `F` / `↓`      | Lane 2 (yellow)              |
| `J` / `↑`      | Lane 3 (green)               |
| `K` / `→`      | Lane 4 (blue)                |
| `M`            | Toggle metronome             |
| `N`            | Toggle hit/miss feedback SFX |
| `Esc`          | Pause (solo) · menu (multi)  |
| `T` (in multi) | Open chat                    |

## Multiplayer

Up to 8 players race the same chart in real time. The flow is:

1. **Create or join** — `/multi` opens the lobby; one player creates a
   room (gets a 4-letter code), the others join via the code or a
   shared link (`/multi/<code>`).
2. **Pick a song** — the host rolls a random chart from the same osu!
   mirrors solo uses; everyone else votes ready when they've finished
   downloading + decoding it. While the loading screen is up
   (`components/multi/LoadingScreen.tsx`), `MultiGame` runs an audio-
   graph + renderer pre-warm pass (see the `prep` effect in
   `components/multi/MultiGame.tsx`) so the first frame after the
   countdown is jank-free for every player, not just the host.
3. **Race** — server sends a synchronized 3-2-1 countdown
   (`PrestartOverlay`), then each client runs the chart locally and
   broadcasts judgment events. The server fans them out at a fixed
   tick (`lib/server/io.ts`, `emitSnapshot`), so per-player CPU is the
   same as solo.
4. **Settle** — final scores show in `ResultsScreen`. Players can
   rematch the same chart or re-roll.

Architecture notes:

- **Transport**: Socket.IO 4, both Next.js and the WS server share
  the same port via `server.ts`. Rooms live in-memory on the server
  (no DB) — eviction is timer-based, see `lib/server/io.ts`.
- **Authority model**: scores are computed client-side and the
  server simply fans them out. This is a casual party game, not a
  leaderboard — the trade-off is honesty (a determined client can
  cheat) for ~zero server CPU and a tiny bandwidth budget.
- **Disconnect handling**: a dropped client keeps their slot for
  60 s (`PLAYER_GRACE_MS` in `lib/server/io.ts`) so a refresh or
  flaky Wi-Fi doesn't kick them out of an in-progress match. An
  empty room itself lingers for 10 min before the server reaps it.
- **Settings parity**: solo and multi share the same `RenderQuality`,
  metronome, SFX, FPS-lock, and judgment-glyph toggles
  (`lib/game/settings.ts`), persisted to `localStorage` per browser.

The full Socket.IO event vocabulary lives in `lib/multi/protocol.ts`
(shared types so client + server can't drift). The server's room
state machine is in `lib/server/io.ts`.

## Adding a fallback song

The runtime picks a random ranked osu!mania 4K beatmap from the public
mirrors on every refresh. Bundled `public/songs/<slug>/` folders are
the offline fallback when every mirror is unreachable. See
[`public/songs/README.md`](./public/songs/README.md) for how to add
one with `npm run fetch-song`.