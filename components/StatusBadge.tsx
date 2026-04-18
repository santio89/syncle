/**
 * Brutalist-style status pill for an osu! beatmapset.
 *
 * Colors mirror osu's own conventions so players instantly recognize
 * the moderation tier:
 *   - ranked    → accent (the same blue we use for primary actions)
 *   - loved     → rose (community-favorite "loved" mode color)
 *   - qualified → amber (mid-pipeline, awaiting full ranked)
 *   - approved  → emerald (rare legacy approval state)
 *   - other     → muted bone (graveyard / wip / unknown)
 *
 * Renders nothing if `status` is empty — `{status && <StatusBadge ... />}`
 * is the intended call site, but the internal guard keeps the component
 * safe to mount unconditionally.
 */
export function StatusBadge({
  status,
  size = "sm",
}: {
  status: string | undefined | null;
  /** "sm" for chip-density listings, "xs" for tight inline placements. */
  size?: "xs" | "sm";
}) {
  if (!status) return null;
  const s = status.toLowerCase();
  const palette =
    s === "loved"
      ? "border-rose-400 text-rose-400"
      : s === "qualified"
        ? "border-amber-400 text-amber-400"
        : s === "approved"
          ? "border-emerald-400 text-emerald-400"
          : s === "ranked"
            ? "border-accent text-accent"
            : "border-bone-50/40 text-bone-50/60";
  const sizing =
    size === "xs"
      ? "text-[9.5px] px-1.5 py-px"
      : "text-[10.5px] px-2 py-0.5";
  return (
    <span
      className={`border-2 font-mono uppercase tracking-widest ${palette} ${sizing}`}
      data-tooltip={`Beatmapset moderation status: ${s}`}
    >
      {s}
    </span>
  );
}
