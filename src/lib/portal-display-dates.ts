/** User-visible list/row dates — never ISO `YYYY-MM-DD`. */
export function formatPortalListDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  return Number.isFinite(d.getTime())
    ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : iso;
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
