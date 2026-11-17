/**
 * The one answer to "was this charge paid, and how much of it": the dashboard's Rent collected,
 * its cash-flow revenue and the server's ledger summary all read it, so they cannot disagree.
 * Plain module (no client imports): the server summary imports it too.
 */

type ChargeLike = {
  status?: string | null;
  paidAt?: string | null;
  amountLabel?: string | null;
  balanceLabel?: string | null;
};

const NOT_COLLECTED = new Set(["cancelled", "refunded", "void", "failed"]);

function money(label: string | null | undefined): number {
  if (!label) return 0;
  const n = Number(String(label).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/** Paid in full: the status says so, or a payment time was recorded. A cancelled, refunded, void or failed charge is never collected. */
export function isChargePaid(charge: Pick<ChargeLike, "status" | "paidAt">): boolean {
  if (charge.status && NOT_COLLECTED.has(charge.status)) return false;
  return charge.status === "paid" || Boolean(charge.paidAt);
}

/** Dollars collected on one charge: all of it when paid, the paid portion when partially paid, else 0. */
export function chargePaidAmount(charge: ChargeLike): number {
  const face = money(charge.amountLabel);
  if (isChargePaid(charge)) return face;
  if (charge.status === "partially_paid") return Math.min(face, Math.max(0, face - money(charge.balanceLabel)));
  return 0;
}

/**
 * Whether a ledger row is revenue. An income account is; so is a resident payment whose category
 * the chart did not classify (it is rent money that landed, never a deposit or capital movement).
 */
export function ledgerRowIsRevenue(row: {
  accountType?: unknown;
  categoryCode?: unknown;
  entryType?: unknown;
  source?: unknown;
}): boolean {
  if (row.accountType === "income") return true;
  return (
    row.accountType === "unclassified" &&
    row.entryType === "payment" &&
    row.source === "Resident payment" &&
    !/^(security_deposit|holding_deposit|security_deposit_liability)$/.test(String(row.categoryCode ?? ""))
  );
}
