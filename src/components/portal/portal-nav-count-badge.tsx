/**
 * Sidebar nav count — a small soft-blue count tile beside the label, styled
 * like the home-page workspace's counts (Oct 6). The solid cobalt tone stays
 * reserved for "alert" counts, so a plain count never reads as an alert. A
 * zero renders nothing.
 */
export function PortalNavCountBadge({ count, tone = "muted" }: { count: number; tone?: "muted" | "alert" }) {
  if (count <= 0) return null;
  const label = count > 99 ? "99+" : String(count);
  return (
    <span
      className={
        tone === "alert"
          ? "min-w-[1.25rem] shrink-0 rounded-lg bg-primary px-1.5 text-center text-[11px] font-bold tabular-nums leading-[1.5] text-white"
          : "min-w-[1.125rem] shrink-0 rounded-lg bg-[var(--portal-count-bg,transparent)] px-1.5 py-px text-center text-[11px] font-semibold tabular-nums leading-[1.4] text-primary"
      }
      data-attr="nav-count"
    >
      {label}
    </span>
  );
}
