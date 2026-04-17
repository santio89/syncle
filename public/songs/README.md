# How to drop in an osu! chart

Syncle plays real, human-charted **osu!mania 4K** beatmaps. There is no
hidden audio fallback shipped with the repo — if no chart is found here,
the game shows a "no chart available" message instead of pretending.

## Folder layout

```
public/songs/
  today/
    chart.osu           ← osu! 4K mania difficulty (rename any .osu to chart.osu)
    audio.mp3           ← song audio referenced by the chart
  osu-mania/            ← dev-only test set; loaded automatically if `today/` is empty
    *.osu
    *.mp3
```

The lookup order is hard-coded in `lib/game/chart.ts → OSU_CANDIDATES`:
`today/` first, then the dev test set, then `loadSong()` rejects.

## Step-by-step: import a beatmap

1. **Download a `.osz` beatmap.** A `.osz` is just a renamed zip.
   - In-game: install [osu!](https://osu.ppy.sh/home/download), search the
     beatmap browser, click download. The file lands in your osu! `Songs/` folder.
   - No-account mirrors: [osu.direct](https://osu.direct/),
     [catboy.best](https://catboy.best/), [nerinyan.moe](https://nerinyan.moe/).
     **Filter by mode = mania, keys = 4.**

2. **Pick a 4K Easy/Normal difficulty.** A beatmap set usually contains
   several `.osu` files (one per difficulty). Open them in a text editor —
   the right one has these lines in `[General]` and `[Difficulty]`:

   ```
   Mode: 3
   ...
   CircleSize: 4
   ```

   Anything other than `Mode: 3` and `CircleSize: 4` is rejected by the
   parser and the game moves on to the next candidate.

3. **Extract two files** from the `.osz` zip:
   - the chosen `.osu` file → rename to **`chart.osu`**
   - the audio file (filename matches the chart's `AudioFilename:` line, often
     `audio.mp3`) → keep as **`audio.mp3`**

4. **Drop them here:**
   ```
   public/songs/today/chart.osu
   public/songs/today/audio.mp3
   ```

5. **Refresh the game.** The start card shows `osu! 4K chart` next to the
   song title once the parse works.

## What gets used from the .osu file

| Section          | What we read                                             |
| ---------------- | -------------------------------------------------------- |
| `[General]`      | `Mode` (must be 3), `AudioFilename`                      |
| `[Metadata]`     | `Title`, `Artist` (used as the displayed song name)      |
| `[Difficulty]`   | `CircleSize` (must be 4)                                 |
| `[TimingPoints]` | First uninherited point → BPM (60000/beatLen) and offset |
| `[HitObjects]`   | `x` → lane (`floor(x*4/512)`), `time` → seconds          |
|                  | Hold notes also get an `endTime` (sustains are real now) |

Variable-BPM songs only use the first BPM marker — acceptable for v1.

## Notes on legality

For local development this is fine — the files never leave your machine.
If you ever want to ship publicly, audio needs to be CC-licensed (or you
need rights). The folder structure here doesn't change either way.
