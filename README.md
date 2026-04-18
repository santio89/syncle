# SYNCLE

A brutalist osu!mania-style rhythm game. Random track every refresh,
endless retries, optional **multiplayer rooms** for up to 50 players
racing on the same chart.

> **Status: v0.3** — single-player + multiplayer rooms (Socket.IO) are
> live. Per-track local best scores, lifetime aggregates, and a sidebar
> live scoreboard during multi runs. Cloud sync for stats lands next.

## Stack

- **Next.js 14 (App Router) + TypeScript** — UI + custom server (`server.ts`).
- **Tailwind CSS** — brutalist dark/light theme with a single blue accent.
- **Web Audio API** — sample-accurate audio scheduling. Song time reads
  off `AudioContext.currentTime` so the chart locks to the audio clock,
  never to `requestAnimationFrame`.
- **Canvas 2D** — perspective highway, falling notes, hold trails, hit
  feedback at 60fps.
- **Socket.IO** — long-lived WebSocket fan-out for multiplayer rooms.
  Room registry + event wiring live in `lib/server/io.ts`. Two entry
  points reuse the same wiring: `server.ts` mounts it on the same HTTP
  listener as Next.js (used in dev), and `socket-server.ts` runs it
  standalone (used in the recommended split deploy below). Both are run
  directly with `tsx` so there's no separate compile step.

## Run it

```bash
npm install
npm run dev
```

`npm run dev` runs `tsx watch server.ts`, which starts Next.js + the
Socket.IO server on the same port (default 3000). Open
http://localhost:3000 and hit **PLAY**, or click **░ multi** in the
header to spin up a multiplayer room.

For production:

```bash
npm run build      # next build
npm start          # tsx scripts/start.mjs → tsx server.ts
```

## Multiplayer rooms

- Click **░ multi** in the header (or open `/multi`) to create or join a
  room.
- Each room has a 6-character code (A–Z + 2–9, no ambiguous chars).
- Up to 50 players per room.
- The host picks a song from the public osu!mania catalog and a
  difficulty; everyone else watches the lobby update in real time.
- On **Start**, every client downloads + decodes the song in parallel
  (30s deadline). Once everyone is ready the server picks a wall-clock
  T0 and the audio fires for everyone within a few ms.
- During play you see your own canvas + a live sidebar scoreboard
  updating ~5 times per second.
- At the end everyone gets a standings screen and a choice: **keep
  playing** (back to lobby) or **leave** (back to the main menu). The
  host can kick the next round whenever they're ready.
- Refresh-safe: your seat is held for 60s after a disconnect. Just hit
  the same URL again.

## Deploying

The recommended setup is a **split deploy** — Vercel for the Next.js
app, Render (free tier is fine) for the tiny Socket.IO service. Same
GitHub repo, two deploy targets.

```
                    GitHub repo (this one)
                            │
            ┌───────────────┴────────────────┐
            ▼                                ▼
        Vercel                            Render
   ─────────────────                 ───────────────────
   Next.js app                       socket-server.ts
   (single-player,                   (multiplayer rooms,
    UI shell, static)                 Socket.IO only)
   Cold start ~ instant              Persistent Node process
   build: next build                 build: npm install
                                     start: npm run socket:start
            │                                ▲
            └─────── browser ────────────────┘
                  (websocket via NEXT_PUBLIC_SOCKET_URL)
```

Why split: Vercel's serverless model can't hold long-lived WebSocket
connections, but it gives the single-player app instant cold starts and
edge caching. Render keeps a persistent Node process for the realtime
layer. Single-player never depends on the socket server, so it's
unaffected if Render is asleep / waking up.

### 1. Render (multiplayer socket server)

Connect the repo via Render → **Blueprints** → **New from `render.yaml`**.
The included blueprint provisions a single Web Service:

- **Build command:** `npm install`
- **Start command:** `npm run socket:start` (`tsx socket-server.ts`)
- **Health check path:** `/healthz`
- **Env vars:**
  - `NODE_ENV=production`
  - `PORT` is injected by Render automatically.
  - `CORS_ORIGINS` — comma-separated allow-list. Supports `*` wildcards
    in subdomains, e.g.
    `https://syncle.vercel.app,https://*.vercel.app` covers production
    plus every Vercel preview deploy. Leave unset to allow any origin
    (fine for first-deploy smoke tests).

Free tier sleeps after ~15 minutes of inactivity (~30 s wake-up on the
first connection). Bump to **Starter** ($7/mo) for always-on
multiplayer. Single-player is unaffected either way.

### 2. Vercel (Next.js app)

Import the repo into Vercel — it auto-detects Next.js. The included
`vercel.json` pins the build command so Vercel ignores the custom
`server.ts` at the repo root.

Add one env var in **Project Settings → Environment Variables**:

- `NEXT_PUBLIC_SOCKET_URL` = `https://<your-render-service>.onrender.com`

Set this for every environment (Production / Preview / Development) so
preview deploys can also talk to the socket server. The hook in
`hooks/useRoomSocket.ts` reads this at build time and connects there
instead of same-origin.

### Local dev

You don't need two terminals locally. `npm run dev` runs the combined
`server.ts` (Next + Socket on the same port, default 3000-3004). If you
want to mirror the production split for testing, run them separately:

```bash
npm run socket:dev          # standalone socket server on :4000
NEXT_PUBLIC_SOCKET_URL=http://localhost:4000 npm run dev
```

A smoke test that drives a full multiplayer handshake against any
deployed server is included:

```bash
SYNCLE_URL=https://your-render-service.onrender.com npm run smoke:multi
```

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

## Best scores

Random song every refresh, infinite retries. Per-track best lives in
`localStorage` under `syncle.best.<songId>.<easy|normal|hard>`. Lifetime
aggregates (tracks played, total runs, all-time best) live alongside it.

Cloud sync (Firestore) for multiplayer cross-device leaderboards is on
the roadmap.

## Project layout

```
server.ts                  Combined Next.js + Socket.IO server (local dev)
socket-server.ts           Standalone Socket.IO-only server (Render prod)
render.yaml                Render blueprint for the socket service
vercel.json                Vercel build pin for the Next.js app
app/
  page.tsx                 Landing — today's track + multiplayer CTA
  play/page.tsx            Single-player game shell
  multi/page.tsx           Multiplayer create/join entry
  multi/[code]/page.tsx    Live multiplayer room
components/
  Game.tsx                 Single-player React + canvas integration
  multi/Lobby.tsx          Player list + host song picker
  multi/LoadingScreen.tsx  "Waiting for X / N ready" view
  multi/MultiGame.tsx      Canvas + live sidebar scoreboard
  multi/ResultsScreen.tsx  Final standings + keep/leave choice
hooks/
  useRoomSocket.ts         Owns the socket.io-client connection + room state
lib/multi/
  protocol.ts              Type-only Socket.IO event + payload contracts
lib/server/
  io.ts                    Room registry + Socket.IO event wiring
  catalog.ts               osu!mania catalog fetcher (mirror-backed, cached)
lib/game/
  types.ts                 Note / Judgment / Stats / lane mapping (4 lanes)
  audio.ts                 Web Audio engine wrapper
  chart.ts                 Random-song discovery + per-mode chart loader
  osu.ts                   Minimal .osu (osu!mania 4K) parser
  engine.ts                Hit detection, hold tracking, scoring, combo
  renderer.ts              Canvas drawing — highway, notes, popups
  best.ts                  Per-track localStorage high-score helpers
  stats.ts                 Lifetime aggregate stats
public/
  songs/                   Local fallback song pool
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

- [x] Hold notes (sustain)
- [x] Difficulty (easy / normal / hard)
- [x] Per-track local high score + lifetime stats
- [x] Random song every refresh (osu!mania mirror discovery)
- [x] Light/dark theme
- [x] Multiplayer rooms (Socket.IO, up to 50 players, race-style)
- [ ] Cloud sync (Firestore) for cross-device stats
- [ ] Global leaderboards (per song)
- [ ] Calibration / audio offset slider
- [ ] Spectator slot for room hosts
- [ ] More songs + chart authoring tool
