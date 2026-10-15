/**
 * The one shape of a charge's due fact. A "By <date>" window (proration
 * charges) reads "Due by <date>"; a bare display date reads "Due <date>";
 * a label that already says Due / Before is kept; anything else is a phrase
 * the caller decides how to show (see `looksLikeDueDate`).
 */
const DISPLAY_DATE = /^[A-Z][a-z]{2,8}\.? \d{1,2}(, \d{4})?$/;
const BY_DATE = /^by\s+(\S.*)$/i;

/** True for "Oct 12, 2026" and "By Oct 12, 2026" (a date the Due prefix belongs on). */
export function looksLikeDueDate(label: string): boolean {
  const t = label.trim();
  const by = BY_DATE.exec(t);
  return DISPLAY_DATE.test(by ? by[1]!.trim() : t);
}

/** "Due by <date>" / "Due <date>"; other labels come back unchanged (trimmed). */
export function formatChargeDueLabel(label: string): string {
  const t = label.trim();
  if (!t) return "";
  const by = BY_DATE.exec(t);
  if (by && DISPLAY_DATE.test(by[1]!.trim())) return `Due by ${by[1]!.trim()}`;
  if (DISPLAY_DATE.test(t)) return `Due ${t}`;
  return t;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ISO_DATE = /^(by\s+|before\s+)?(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/i;

/**
 * A stored ISO date ("2026-10-07", optionally with a By / Before prefix or a time part) as the
 * product's display date ("Oct 7, 2026"). The calendar date is read straight from the string - a
 * date-only value is a wall date, so it is never run through `Date` and shifted by a timezone.
 * Anything that is not an ISO date comes back trimmed and unchanged.
 */
export function humanizeChargeDate(label: string): string {
  const t = label.trim();
  const m = ISO_DATE.exec(t);
  if (!m) return t;
  const month = Number(m[3]);
  const day = Number(m[4]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return t;
  const prefix = m[1] ? (m[1].trim().toLowerCase() === "by" ? "By " : "Before ") : "";
  return `${prefix}${MONTHS[month - 1]} ${day}, ${m[2]}`;
}

const MONEY_LABEL = /^(-)?\s*\$?\s*(-)?(\d[\d,]*(?:\.\d+)?)$/;

/** "$1800.00" / "1800" as "$1,800.00". A label that is not a plain amount comes back unchanged. */
export function formatChargeMoneyLabel(label: string): string {
  const t = label.trim();
  const m = MONEY_LABEL.exec(t);
  if (!m) return label;
  const n = Number(m[3]!.replace(/,/g, ""));
  if (!Number.isFinite(n)) return label;
  const body = n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${m[1] || m[2] ? "-" : ""}$${body}`;
}
