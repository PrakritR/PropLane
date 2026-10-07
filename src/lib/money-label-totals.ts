/**
 * Totals for a money list's stat strip. A row's own cent figure is the truth
 * whenever it has one; only a row that carries nothing but a display label
 * ("$1,200.00") is read off that label, and then only when the label really is
 * a money figure - free text a manager typed into a cost field ("approx 1.5k")
 * is not a number and adds nothing rather than a wrong number.
 */

export type MoneyRowAmount = {
  /** The row's own figure in whole cents. Preferred over any label. */
  cents?: number | null;
  /** The dollar label the row displays, read only when `cents` is absent. */
  label?: string | null;
};

/** `"$1,150.00"` -> 115000, `"-$25.00"` / `"($25.00)"` -> -2500, anything else -> 0. */
function labelToCents(label: string | null | undefined): number {
  const raw = String(label ?? "").trim();
  if (!raw) return 0;
  const parenthesised = raw.startsWith("(") && raw.endsWith(")");
  const body = (parenthesised ? raw.slice(1, -1) : raw).trim();
  const negative = parenthesised || body.startsWith("-") || body.startsWith("$-");
  const digits = body.replace(/^-/, "").replace(/^\$\s*-?/, "").replace(/,/g, "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(digits)) return 0;
  const n = Number(digits);
  if (!Number.isFinite(n)) return 0;
  const cents = Math.round(n * 100);
  return negative ? -cents : cents;
}

/** Sum of the rows' amounts, in cents. A row with neither a figure nor a money label adds nothing. */
export function sumMoneyRowsCents(rows: readonly MoneyRowAmount[]): number {
  let total = 0;
  for (const row of rows) {
    total += typeof row.cents === "number" && Number.isFinite(row.cents) ? row.cents : labelToCents(row.label);
  }
  return total;
}

/** Rows that carry only a display label (the incoming ledger) - see {@link sumMoneyRowsCents}. */
export function sumMoneyLabelsCents(labels: readonly (string | null | undefined)[]): number {
  return sumMoneyRowsCents(labels.map((label) => ({ label })));
}

/** "$1,200.00" - always two decimals, like every amount on a payment row. */
export function formatCentsAsUsd(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}
