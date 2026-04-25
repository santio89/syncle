/**
 * Pure difficulty classification — no I/O, no browser-only deps.
 *
 * Lives in its own tiny module (instead of inside `lib/game/chart.ts`)
 * because BOTH the client (chart loader) and the server (catalog
 * normalization, multiplayer difficulty filter) need to bucket charts
 * into Syncle tiers, and `chart.ts` transitively imports browser-only
 * code (audio decoding, blob handling) that the Node server can't pull
 * in without dragging in DOMException-shaped surprises.
 *
 * Contract:
 *   - We classify a single mapper-shipped osu!mania chart into one of
 *     five Syncle tiers using its mapper-given difficulty NAME and its
 *     real notes-per-second density. Name is the primary signal,
 *     density is the tiebreaker / sanity check.
 *   - We DO NOT modify the chart itself here — no quantization, no
 *     subsampling, no synthesis. Those concepts were removed from the
 *     codebase along with the "show every tier on every song" model;
 *     the player now sees exactly the tiers the mapper actually shipped
 *     for a given song. Buttons for missing tiers are disabled in the
 *     picker.
 */

/**
 * Five-tier Syncle difficulty axis. Mirrors the mapper's typical
 * easy/normal/hard/insane/expert spread but quantized into a fixed
 * vocabulary so the picker UI / leaderboard keys / multi protocol
 * stay stable across every song.
 *
 * NOTE on `"normal"`: stored on the wire, in localStorage, and in the
 * leaderboard as `"normal"` for backward compatibility — labelled as
 * `"medium"` in the UI via {@link displayMode}.
 */
export type ChartMode = "easy" | "normal" | "hard" | "insane" | "expert";

/**
 * Difficulty order, easiest → hardest. Used for picker layout, walking
 * to the next-available mode when a song doesn't ship the requested
 * difficulty, and computing range labels (e.g. "easy-expert").
 */
export const MODE_ORDER: ChartMode[] = [
  "easy",
  "normal",
  "hard",
  "insane",
  "expert",
];

/**
 * Map an internal {@link ChartMode} to the label we actually show users.
 * `"normal"` displays as `"medium"`; everything else is identity.
 */
export function displayMode(
  mode: ChartMode,
): "easy" | "medium" | "hard" | "insane" | "expert" {
  return mode === "normal" ? "medium" : mode;
}

/**
 * Per-tier notes-per-second band — the canonical density window for
 * "what is a Hard?". Used for two decisions only (synthesis is gone):
 *
 *   1. Bucket validation. A mapper-named "Hard" only counts as Hard if
 *      its real density falls in `[min, max]`. A "Hard" chart at 14 nps
 *      is misclassified — we re-bucket it into Insane or Expert based
 *      on the density band that actually contains it.
 *   2. Density-only fallback when a mapper's name gives nothing usable
 *      ("[4K Lv.27]", "Promethean Kings", etc.) — `classifyByDensity`
 *      walks the bands and picks the one containing the chart's nps.
 *
 * Bands overlap by ~0.5 nps at boundaries and are biased toward the
 * easier tier on ambiguous values so a borderline 5.0-nps chart lands
 * in Normal rather than barely-Hard. Mappers tend to over-rate, not
 * under-rate, so this matches reader expectations.
 */
export const TIER_BANDS: Record<
  ChartMode,
  { min: number; max: number }
> = {
  easy: { min: 1.5, max: 3.5 },
  normal: { min: 3.0, max: 5.0 },
  hard: { min: 4.5, max: 7.5 },
  insane: { min: 6.5, max: 10.5 },
  // Expert has no real upper cap — anything above 10.5 nps reads as
  // Expert. We deliberately let the original chart through as-is,
  // even at 25+ nps, because the user opted into "originals only" and
  // an unplayable Expert button is a more honest signal than silently
  // thinning notes off the bottom of the chart.
  expert: { min: 9.5, max: Infinity },
};

/**
 * Tier whose `[min, max]` band contains `nps`. Used for re-bucketing
 * misclassified mapper charts and for "purely density-driven"
 * classification when the mapper's name gives us nothing to go on.
 *
 * Walks easiest → hardest and returns the FIRST band that contains the
 * value, biasing ambiguous densities toward the easier tier. Below the
 * easy floor → easy; above expert.min → expert (which is open-ended).
 */
export function classifyByDensity(nps: number): ChartMode {
  if (nps < TIER_BANDS.easy.min) return "easy";
  for (const tier of MODE_ORDER) {
    const band = TIER_BANDS[tier];
    if (nps >= band.min && nps <= band.max) return tier;
  }
  return "expert";
}

/**
 * Mapper-name → tier hint. Returns `null` for unrecognized names so the
 * caller can fall back to density-only classification.
 *
 * Order matters: most specific / hardest names first so a chart called
 * "Insane Expert" classifies as expert instead of being shadowed by the
 * earlier "insane" branch.
 */
export function classifyDifficultyByName(version: string): ChartMode | null {
  const v = version.toLowerCase();
  if (
    /(expert|extra|\blunatic\b|master|overdose|extreme|edge|deathmoon|\bshd\b)/.test(
      v,
    )
  ) {
    return "expert";
  }
  if (/(insane|\bhyper\b|\bheavy\b|another|crazy)/.test(v)) return "insane";
  if (/(hard|advanced|\bhd\b|rain)/.test(v)) return "hard";
  if (/(normal|basic|medium|\bnm\b|regular|intermediate|platter)/.test(v))
    return "normal";
  if (/(beginner|easy|novice|gentle|noob|lite|casual|cup|salad)/.test(v))
    return "easy";
  return null;
}

/**
 * Pick the bucket a mapper chart actually belongs to. Name is the
 * primary signal but density gets the final say WHEN WE HAVE IT —
 * if the name says one tier and the real nps clearly says another,
 * we trust the math.
 *
 * The catch: server-side, we run this function against beatmap
 * metadata pulled from a mirror BEFORE the .osz is downloaded, and
 * not every mirror exposes hit-object counts on every diff (some
 * return zeros, some omit the fields entirely). When that happens
 * `nps` is 0 / non-finite and `classifyByDensity(0)` would dump
 * everything into Easy — that's the "every catalog row says EASY"
 * bug. So we treat `nps <= 0` (or NaN) as "no density signal" and
 * lean entirely on the mapper name, which is always present.
 *
 * Examples (with density):
 *   - mapper "Hard" at 6 nps     → name says Hard, density confirms (4.5-7.5) → Hard
 *   - mapper "Hard" at 14 nps    → name says Hard, density says Expert (9.5+)  → Expert
 *   - mapper "[4K Lv.27]" at 8.2 → name unrecognized, density 8.2 ∈ Insane    → Insane
 *
 * Examples (no density signal — `nps <= 0` or `NaN`):
 *   - mapper "Hard"      → trust the name → Hard
 *   - mapper "Lunatic"   → trust the name → Expert
 *   - mapper "[4K Lv.?]" → unknown name + no density → fall back to "normal"
 *     (safer than Easy, which would let a 12-nps chart slip into the Easy
 *      filter)
 */
export function assignBucket(version: string, nps: number): ChartMode {
  const named = classifyDifficultyByName(version);
  const haveDensity = Number.isFinite(nps) && nps > 0;
  if (!haveDensity) {
    return named ?? "normal";
  }
  if (named) {
    const band = TIER_BANDS[named];
    if (nps >= band.min && nps <= band.max) return named;
  }
  return classifyByDensity(nps);
}
