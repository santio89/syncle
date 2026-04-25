# Local fallback songs

Syncle's runtime now picks a **random ranked 4K beatmap** on every
page load by hitting public mirror search APIs (nerinyan.moe / osu.direct).
The picked .osz is downloaded + unzipped in the browser, no manifest
involved, no GitHub Release needed.

This folder exists only as a **fallback for when every mirror is
unreachable** (offline dev, mirror outage, blocked region, etc.). The two
folders here ship with the repo and are referenced by the
`LOCAL_FALLBACKS` array in [`lib/game/chart.ts`](../../lib/game/chart.ts).

## Adding a new fallback song

```bash
# Search mirrors for a 4K chart
npm run fetch-song -- search "camellia"

# Download a beatmapset by id (optionally pick a difficulty by name)
npm run fetch-song -- 2012308 "Beginner"
```

The `fetch-song` script extracts the audio + chart and drops them into
`public/songs/<slug>/audio.mp3` + `public/songs/<slug>/chart.osu`.

After the files exist, register the song by adding an entry to
`LOCAL_FALLBACKS` in `lib/game/chart.ts`:

```ts
{
  id: "your-new-song",
  title: "Display Title",
  artist: "Artist Name",
  year: 2024,
  audioUrl: "/songs/your-new-song/audio.mp3",
  chartUrl: "/songs/your-new-song/chart.osu",
},
```

That's it - no build step, no JSON config, no manifest regeneration.

## What our parser requires

| Section          | Required value                                           |
| ---------------- | -------------------------------------------------------- |
| `[General]`      | `Mode: 3` (key-mode), `AudioFilename`                    |
| `[Difficulty]`   | `CircleSize: 4` (4-key)                                  |
| `[TimingPoints]` | At least one uninherited point → BPM + offset            |
| `[HitObjects]`   | `x` → lane (`floor(x*4/512)`), `time` → seconds          |
|                  | Hold notes also get an `endTime` (sustains are real)     |

Anything else is rejected by the parser. Variable-BPM songs only use the
first BPM marker - acceptable for v1.

## Future: daily song scheduling

The current "fresh random song every refresh" behaviour is intentional for
v0.x - it's the fastest way to see a wide variety of charts during
development. A future `Firestore`-backed daily scheduler will pick **one**
beatmapset id per day so every player on a given date gets the same chart
(needed for daily leaderboards). When that lands, this fallback list is
what the scheduler will use on days where its primary source is empty.

## Notes on legality

For local development this is fine - fallback files never leave your
machine. If you ever publish copyrighted audio to a public deployment,
you're hosting it publicly regardless of where it physically sits. For
anything beyond personal use, prefer CC-licensed audio or a "bring your
own beatmap" model.
