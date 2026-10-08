/**
 * Sidebar nav count (approved shell redesign). An "alert" count (unread mail,
 * something overdue) is a solid red 18px pill with a white 11px bold figure; a
 * quiet count is just a muted 12px number pushed to the right edge — never a
 * tile or chip, so a plain count cannot be mistaken for an alert. A zero
 * renders nothing. Figures only use tabular numerals.
 */
export function PortalNavCountBadge({ count, tone = "muted" }: { count: number; tone?: "muted" | "alert" }) {
  if (count <= 0) return null;
  const label = count > 99 ? "99+" : String(count);
  return (
    <span
      className={
        tone === "alert"
          ? "inline-grid h-[18px] min-w-[18px] shrink-0 place-items-center rounded-[9px] bg-[#d92d20] px-[5px] text-[11px] font-bold leading-none text-white [font-feature-settings:'tnum']"
          : "shrink-0 text-[12px] font-medium leading-none text-muted [font-feature-settings:'tnum']"
      }
      data-attr="nav-count"
      data-tone={tone}
    >
      {label}
    </span>
  );
}
