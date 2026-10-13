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
