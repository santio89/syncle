# Song catalog & manifest

Syncle plays real, human-charted **osu!mania 4K** beatmaps. The runtime
doesn't have any audio hard-coded — at startup it reads `manifest.json`
(generated from `songs.config.json` at the repo root) and fetches whatever
that points to.

`manifest.json` is **a build artifact**: do not edit it directly, do not
commit it. It's regenerated every time you run `npm run dev`,
`npm run build`, or `npm run build:manifest`.

## Two delivery modes

The build script picks one automatically:

- **remote** — `release.owner/repo/tag` in `songs.config.json` is set, the
  GitHub API is reachable, and the listed assets exist in that release.
  Manifest URLs point at GitHub Releases (free, fast, CDN-served, no repo
  bloat). This is what you want in production.

- **local** — no release configured (or the API call failed). Manifest
  URLs point at `/songs/...` in `/public`. Useful for offline development
  and for trying out a new song before you publish it.

The manifest itself records which mode it was built in (`"mode": "remote"`
or `"mode": "local"`) and the reason — handy for debugging.

## Adding a new song (recommended workflow)

### 1. Pick a 4K mania beatmap

**Easy way — use the built-in fetcher:**

```bash
# Search public mirrors for mania charts
npm run fetch-song -- search "camellia"

# Install one by beatmapset id (optionally pick a specific difficulty)
npm run fetch-song -- 2012308 "Beginner"
```

The fetcher pulls from [catboy.best](https://catboy.best/) (with
[nerinyan.moe](https://nerinyan.moe/) as a fallback), unzips the `.osz` in
memory, picks a 4K mania difficulty, and drops `audio.mp3` + `chart.osu`
into `public/songs/<slug>/`. It then prints a ready-to-paste
`songs.config.json` snippet.

**Manual way:** download a `.osz` from any of the mirrors above, rename it
to `.zip`, extract, then look for an `.osu` whose header has:

```
Mode: 3
CircleSize: 4
```

Anything else is rejected by our parser.

### 2. Upload the audio + chart to your GitHub Release

```bash
gh release upload songs-v1 ./path/to/audio.mp3 ./path/to/chart.osu
```

(Or drag-and-drop in github.com → Releases → edit `songs-v1` → attach.)

Filenames are arbitrary as long as they match the `audio` and `chart`
fields you put in `songs.config.json`. Recommended: `<song-id>.mp3` and
`<song-id>.osu` for sanity.

### 3. Add the song to `songs.config.json`

```json
{
  "release": { "owner": "you", "repo": "syncle", "tag": "songs-v1" },
  "schedule": [
    { "date": "2026-04-17", "songId": "credens-justitiam" },
    { "date": "2026-04-18", "songId": "your-new-song" }
  ],
  "songs": {
    "your-new-song": {
      "title": "Display Title",
      "artist": "Artist Name",
      "year": 2024,
      "audio": "your-new-song.mp3",
      "chart": "your-new-song.osu"
    }
  }
}
```

### 4. Push

`git push` → Vercel rebuilds → `npm run build:manifest` runs as a
prebuild hook → manifest gets regenerated with the new URLs → live.

## Local-only workflow (no GitHub setup needed)

For a quick test before you create the release: drop the files anywhere
under `public/songs/` and reference them as paths in `songs.config.json`:

```json
"songs": {
  "demo": {
    "title": "Demo",
    "artist": "Me",
    "audio": "demo/audio.mp3",
    "chart": "demo/chart.osu"
  }
}
```

Files at `public/songs/demo/audio.mp3` and `public/songs/demo/chart.osu`
will be served by Next directly. The manifest will be built in `local`
mode and everything just works for dev.

## Schedule rules

- Dates are local-time `YYYY-MM-DD`.
- Lookup picks: exact-date match → most recent past date → first song.
- So if you forget to schedule tomorrow, today's song "sticks" until you
  add a new entry.

## What gets read from the .osu file

| Section          | What we read                                             |
| ---------------- | -------------------------------------------------------- |
| `[General]`      | `Mode` (must be 3), `AudioFilename`                      |
| `[Metadata]`     | `Title`, `Artist` (overridden by config when present)    |
| `[Difficulty]`   | `CircleSize` (must be 4)                                 |
| `[TimingPoints]` | First uninherited point → BPM (60000/beatLen) and offset |
| `[HitObjects]`   | `x` → lane (`floor(x*4/512)`), `time` → seconds          |
|                  | Hold notes also get an `endTime` (sustains are real)     |

Variable-BPM songs only use the first BPM marker — acceptable for v1.

## Notes on legality

For local development this is fine — files never leave your machine.
Once you publish a release with copyrighted audio, you're hosting it
publicly regardless of where it physically sits (GitHub, S3, R2, etc.).
For anything beyond personal use, prefer CC-licensed audio or a
"bring your own beatmap" model.
