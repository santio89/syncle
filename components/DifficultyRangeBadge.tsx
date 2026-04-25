import { ChartMode, MODE_ORDER, displayMode } from "@/lib/game/difficulty";

/**
 * Brutalist-style pill that summarizes the difficulty SPREAD a song
 * actually ships. Replaces the old `StatusBadge` (ranked / loved /
 * qualified / etc.) on the home screen and the in-match StartCard
 * because moderation status was opaque to non-osu players, while the
 * difficulty range answers the only question they actually ask:
 * "what tiers can I pick on this song?".
 *
 * Rendering:
 *   - One bucket → just that name ("hard").
 *   - Multiple buckets → easiest-hardest range ("easy-expert"). We
 *     don't enumerate every tier (e.g. "easy/normal/expert") because
 *     the picker UI itself shows availability; the badge's job is to
 *     give a glanceable bound, not a full inventory.
 *   - Empty / undefined → render nothing. Caller doesn't need to
 *     conditionally mount; this stays safe to drop in.
 *
 * Color: theme accent (the same blue we use for primary actions and
 * the `ranked` status before it), so the slot the badge occupies
 * stays visually identical when we swap it in.
 */
export function DifficultyRangeBadge({
  buckets,
  size = "sm",
}: {
  /**
   * Buckets the song actually contains, in any order. Caller usually
   * passes `SongRef.availableBuckets`; we re-sort defensively into
   * `MODE_ORDER` so the rendered range is always easiest → hardest
   * regardless of upstream ordering.
   */
  buckets: ChartMode[] | undefined | null;
  size?: "xs" | "sm";
}) {
  if (!buckets || buckets.length === 0) return null;
  const sorted = MODE_ORDER.filter((m) => buckets.includes(m));
  if (sorted.length === 0) return null;
  const lowest = displayMode(sorted[0]);
  const highest = displayMode(sorted[sorted.length - 1]);
  const label = lowest === highest ? lowest : `${lowest}-${highest}`;
  const sizing =
    size === "xs"
      ? "text-[9.5px] px-1.5 py-px"
      : "text-[10.5px] px-2 py-0.5";
  const tooltip =
    sorted.length === 1
      ? `Only one difficulty available on this song: ${lowest}`
      : `Difficulty range available on this song: ${lowest} to ${highest}`;
  return (
    <span
      className={`border-2 border-accent text-accent font-mono uppercase tracking-widest ${sizing}`}
      data-tooltip={tooltip}
    >
      {label}
    </span>
  );
}
