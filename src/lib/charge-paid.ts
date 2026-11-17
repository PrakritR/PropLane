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
/** Money that has NOT cleared in full: a clearing ACH and a part payment are never "paid", whatever time is stamped. */
const NOT_PAID_IN_FULL = new Set(["processing", "partially_paid"]);

function money(label: string | null | undefined): number {
  if (!label) return 0;
  const n = Number(String(label).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/** Paid in full: the status says so, or a payment time was recorded. A cancelled, refunded, void or failed charge is never collected. */
export function isChargePaid(charge: Pick<ChargeLike, "status" | "paidAt">): boolean {
  if (charge.status && NOT_COLLECTED.has(charge.status)) return false;
  if (charge.status === "paid") return true;
  if (charge.status && NOT_PAID_IN_FULL.has(charge.status)) return false;
  return Boolean(charge.paidAt);
}

/** Dollars collected on one charge: all of it when paid, the paid portion when partially paid, else 0. */
export function chargePaidAmount(charge: ChargeLike): number {
  const face = money(charge.amountLabel);
  if (isChargePaid(charge)) return Math.max(0, face);
  if (charge.status === "partially_paid") return Math.min(Math.max(0, face), Math.max(0, face - money(charge.balanceLabel)));
  return 0;
}

/**
 * Whether a ledger row is revenue. An income account is; so is a resident payment whose category
 * the chart did not classify (it is rent money that landed, never a deposit or capital movement).
 *
 * A refund of such a payment is the SAME row shape with a negative amount, and it must pass this
 * test too — a summary that counts the payment and skips its refund overstates revenue forever.
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
    (row.entryType === "payment" || row.entryType === "refund") &&
    row.source === "Resident payment" &&
    !/^(security_deposit|holding_deposit|security_deposit_liability)$/.test(String(row.categoryCode ?? ""))
  );
}
