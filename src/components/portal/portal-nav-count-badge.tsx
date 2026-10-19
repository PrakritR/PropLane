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
          ? "inline-grid h-[18px] min-w-[18px] shrink-0 place-items-center rounded-[9px] bg-[#b42318] px-[5px] text-[11px] font-bold leading-none text-white [font-feature-settings:'tnum']"
          : "shrink-0 text-[12px] font-medium leading-none text-muted [font-feature-settings:'tnum']"
      }
      data-attr="nav-count"
      data-tone={tone}
    >
      {label}
    </span>
  );
}

/** The padlock on a locked nav row — one glyph for the desktop sidebar and the phone More sheet. */
export function NavLockIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      data-nav-lock-icon=""
    >
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}
