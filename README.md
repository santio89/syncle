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

| Key            | Action            |
| -------------- | ----------------- |
| `D` / `←`      | Lane 1 (red)      |
| `F` / `↓`      | Lane 2 (yellow)   |
| `J` / `↑`      | Lane 3 (green)    |
| `K` / `→`      | Lane 4 (blue)     |
| `M`            | Toggle metronome  |
| `T` (in multi) | Open chat         |

## Adding a fallback song

The runtime picks a random ranked osu!mania 4K beatmap from the public
mirrors on every refresh. Bundled `public/songs/<slug>/` folders are
the offline fallback when every mirror is unreachable. See
[`public/songs/README.md`](./public/songs/README.md) for how to add
one with `npm run fetch-song`.