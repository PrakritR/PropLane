/** Display helpers for managed-finance surfaces (Finances › Owner payouts, admin Managed finance). Pure, client-safe. */

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-10" as "October 2026". */
export function managedMonthLabel(month: string): string {
  const [year, m] = month.split("-");
  return `${MONTHS[Number(m) - 1] ?? month} ${year}`;
}

/** Cents as dollars: whole dollars without ".00", otherwise two decimals; a negative keeps its sign in front of the "$". */
export function formatManagedUsd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents) / 100;
  return `${sign}$${abs.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(abs) ? 0 : 2, maximumFractionDigits: 2 })}`;
}
