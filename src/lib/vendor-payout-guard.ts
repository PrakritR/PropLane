/**
 * Double-pay guard for the manager's "Mark as paid" on a vendor work order.
 *
 * A work order carries at most one `vendor_payouts` row (unique index), and a
 * row in `pending` or `paid` means PropLane already moved (or is moving) money
 * to the vendor through Stripe Connect. Marking the same job paid again by
 * Zelle / Venmo / ACH would pay the vendor twice on a different rail. The
 * server refuses that write with a 409 naming the payout unless the manager
 * explicitly acknowledges it, and the acknowledgement is written to
 * `audit_log` before anything else is touched. `failed` and `skipped` payouts
 * moved no money, so they never block.
 *
 * Shared by the route, the core, and the confirm modal so the warning names
 * the same payout the server is refusing on.
 */
import type { VendorPayoutStatus } from "@/lib/vendor-payouts";

export const VENDOR_DOUBLE_PAY_ACK_ACTION = "vendor_double_pay_acknowledged";
export const VENDOR_DOUBLE_PAY_CONFLICT_CODE = "existing_payout";

export type ExistingVendorPayoutSummary = {
  id: string;
  status: VendorPayoutStatus;
  amountCents: number;
  stripeTransferId: string | null;
  createdAt: string | null;
};

/** Only a payout that moved (or is moving) money blocks a second mark-paid. */
export function vendorPayoutBlocksMarkPaid(status: string | null | undefined): boolean {
  return status === "pending" || status === "paid";
}

export function existingVendorPayoutStatusLabel(status: VendorPayoutStatus): string {
  if (status === "paid") return "paid";
  if (status === "pending") return "in progress";
  if (status === "failed") return "failed";
  return "skipped";
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** The warning shown on the confirm step and returned in the 409 body. */
export function existingVendorPayoutWarning(payout: ExistingVendorPayoutSummary): string {
  const amount = payout.amountCents > 0 ? ` of ${formatCents(payout.amountCents)}` : "";
  const transfer = payout.stripeTransferId ? ` (Stripe transfer ${payout.stripeTransferId})` : "";
  return `A PropLane payout${amount} to this vendor is already ${existingVendorPayoutStatusLabel(payout.status)} for this service — payout ${payout.id}${transfer}. Marking it paid again may pay the vendor twice.`;
}
