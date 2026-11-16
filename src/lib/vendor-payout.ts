/**
 * How a vendor is paid, as PropLane records it (Phase A: record-keeping only, no send flow).
 *
 *  - `payoutMethod`: a generic label ("Bank app / P2P transfer", "Check", ...), the same vocabulary as a
 *    financial entry's payment method.
 *  - `payoutLast4`: at most the last four digits of whatever account the vendor is paid into, so the owner can
 *    tell two accounts apart. A bank account or routing number is NEVER stored here: anything that is not
 *    exactly four digits is dropped on every save.
 *  - `payoutConnectAccountRef`: a masked Stripe Connect reference, set by the SERVER on read for a vendor who
 *    onboarded through the existing vendor Connect flow (`profiles.stripe_connect_account_id`). It is never
 *    accepted from a client write.
 *  - `visitRateCents`: what one visit costs. "Record payment" prefills its amount from it.
 *
 * Pure and browser-safe: the vendors route normalizes every row through here on read and write.
 */
import { isPaymentMethod, type PaymentMethod } from "@/lib/finance/payment-fields";

export type VendorPayoutFields = {
  payoutMethod?: PaymentMethod;
  payoutLast4?: string;
  /** Server-set, masked ("acct_...4821"). Read-only for every client. */
  payoutConnectAccountRef?: string;
  visitRateCents?: number;
};

const MAX_RATE_CENTS = 10_000_000;

/**
 * The allowed shape of a row's payout fields. Every key comes back (undefined when invalid or absent) so a
 * spread over the row overwrites a bad stored value instead of leaving it behind. The Connect reference is
 * always dropped here; the server re-attaches it on read.
 */
export function normalizeVendorPayoutFields(row: Record<string, unknown>): {
  [K in keyof Required<VendorPayoutFields>]: Required<VendorPayoutFields>[K] | undefined;
} {
  const method = row.payoutMethod;
  const last4 = typeof row.payoutLast4 === "string" ? row.payoutLast4.trim() : "";
  const rate = row.visitRateCents;
  return {
    payoutMethod: isPaymentMethod(method) ? method : undefined,
    payoutLast4: /^\d{4}$/.test(last4) ? last4 : undefined,
    payoutConnectAccountRef: undefined,
    visitRateCents:
      typeof rate === "number" && Number.isFinite(rate) && rate > 0 && rate <= MAX_RATE_CENTS ? Math.round(rate) : undefined,
  };
}

/** "acct_1Nx...4821": the reference a manager recognizes, never the whole id. */
export function maskConnectAccountRef(accountId: string | null | undefined): string | undefined {
  const id = (accountId ?? "").trim();
  if (!/^acct_[A-Za-z0-9]{6,}$/.test(id)) return undefined;
  return `acct_...${id.slice(-4)}`;
}

/** The amount "Record payment" prefills for a vendor: their per-visit rate in dollars, "" when they have none. */
export function visitRatePrefill(row: { visitRateCents?: number | null } | null | undefined): string {
  const cents = row?.visitRateCents;
  return typeof cents === "number" && cents > 0 ? (cents / 100).toFixed(2) : "";
}

export function payoutSummary(row: Pick<VendorPayoutFields, "payoutMethod" | "payoutLast4" | "payoutConnectAccountRef">, labels: Record<PaymentMethod, string>): string {
  const parts = [row.payoutMethod ? labels[row.payoutMethod] : "", row.payoutLast4 ? `••${row.payoutLast4}` : "", row.payoutConnectAccountRef ? `Stripe ${row.payoutConnectAccountRef}` : ""];
  return parts.filter(Boolean).join(" · ");
}
