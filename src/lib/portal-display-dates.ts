/** User-visible list/row dates — never ISO `YYYY-MM-DD`. */
export function formatPortalListDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  return Number.isFinite(d.getTime())
    ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : iso;
}

/**
 * The short date a list row's glyph fact carries — "Oct 3", with the year only
 * when it is not the current one. A bare `YYYY-MM-DD` is a wall date and is
 * read as that day; a full timestamp is read on the Pacific calendar (the
 * product's clock), so a late-evening UTC stamp does not slip to tomorrow.
 * Empty for an unparseable value.
 */
export function formatPortalRowDate(raw: string | null | undefined, nowMs: number = Date.now()): string {
  const value = raw?.trim();
  if (!value) return "";
  const wall = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const d = wall ? new Date(Number(wall[1]), Number(wall[2]) - 1, Number(wall[3]), 12) : new Date(value);
  if (!Number.isFinite(d.getTime())) return "";
  const timeZone = wall ? undefined : "America/Los_Angeles";
  const yearOf = (date: Date) =>
    Number(date.toLocaleDateString("en-US", { year: "numeric", ...(timeZone ? { timeZone } : {}) }));
  const sameYear = yearOf(d) === yearOf(new Date(nowMs));
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    ...(timeZone ? { timeZone } : {}),
  });
}

/**
 * Outgoing payment due copy: raw ISO becomes "Due Oct 2, 2026"; labels that
 * already say Due/Before are kept.
 */
export function formatOutgoingDue(due: string | undefined): string {
  const trimmed = due?.trim() ?? "";
  if (!trimmed) return "";
  const iso = /^(?:(due|before)\s+)?(\d{4})-(\d{2})-(\d{2})$/i.exec(trimmed);
  if (iso) {
    const label = formatPortalListDate(`${iso[2]}-${iso[3]}-${iso[4]}`);
    if (label) {
      const prefix = iso[1] ? iso[1][0]!.toUpperCase() + iso[1].slice(1).toLowerCase() : "Due";
      return `${prefix} ${label}`;
    }
  }
  if (/^(due|before)\b/i.test(trimmed)) return trimmed;
  const plainIso = /^\d{4}-\d{2}-\d{2}$/.test(trimmed);
  return plainIso ? `Due ${formatPortalListDate(trimmed)}` : `Due ${trimmed}`;
}

/** Date portion for "Due: …" detail lines (drops the leading "Due "). */
export function formatOutgoingDueDetail(due: string | undefined): string {
  const formatted = formatOutgoingDue(due).replace(/^Due\s+/i, "").trim();
  return formatted || due?.trim() || "";
}
