/**
 * Totals of dollar labels ("$1,200.00") for a money list's stat strip. Rows carry
 * their amounts as display labels, so the strip sums those exact labels in whole
 * cents - never a second source of truth for what a row says.
 */

function labelToCents(label: string | null | undefined): number {
  const n = Number(String(label ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** Sum of the amounts the labels carry, in cents. A label with no figure ("—") adds nothing. */
export function sumMoneyLabelsCents(labels: readonly (string | null | undefined)[]): number {
  let total = 0;
  for (const label of labels) total += labelToCents(label);
  return total;
}

/** "$1,200.00" - always two decimals, like every amount on a payment row. */
export function formatCentsAsUsd(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}
