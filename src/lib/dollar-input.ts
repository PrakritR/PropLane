/**
 * Dollars typed by a person -> integer cents. Pure and client-safe. "12.5" -> 1250, "$1,200" -> 120000.
 * Null when the text is not a plain amount with at most two decimals (or is zero while `allowZero` is off).
 * Fee math never happens in the browser: this only turns what was typed into the integer the server expects.
 */
export function parseDollarsToCents(raw: string, allowZero = false): number | null {
  const cleaned = raw.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [dollars, cents = ""] = cleaned.split(".") as [string, string?];
  const total = Number(dollars) * 100 + Number((cents ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(total)) return null;
  return total > 0 || (allowZero && total === 0) ? total : null;
}

/** 125000 -> "1250.00"; for prefilling an amount field. */
export function centsToDollarsInput(cents: number): string {
  const safe = Number.isFinite(cents) ? Math.max(0, Math.trunc(cents)) : 0;
  return `${Math.floor(safe / 100)}.${String(safe % 100).padStart(2, "0")}`;
}
