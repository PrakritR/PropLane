/**
 * Sidebar nav count — a quiet, right-aligned number, the way Linear counts
 * issues beside a view. Not a pill: the cobalt pills this replaced were
 * removed in Aug 2026 because every section looked like an alert. A zero
 * renders nothing.
 */
export function PortalNavCountBadge({ count, tone = "muted" }: { count: number; tone?: "muted" | "alert" }) {
  if (count <= 0) return null;
  const label = count > 99 ? "99+" : String(count);
  return (
    <span
      className={
        tone === "alert"
          ? "min-w-[1.25rem] shrink-0 rounded-full bg-primary px-1.5 text-center text-[10.5px] font-bold tabular-nums leading-[1.5] text-white"
          : "shrink-0 text-[11.5px] font-medium tabular-nums text-muted/80"
      }
      data-attr="nav-count"
    >
      {label}
    </span>
  );
}
