/**
 * Vendor payout timeline — the dated steps between "the manager approved the
 * job" and "the money reached (or did not reach) the vendor's bank".
 *
 * Every step is sourced from a column that already exists: the invoice's
 * `decided_at`, the work order's `paidAt`, and the `vendor_payouts` row's
 * `created_at` / `updated_at` / `stripe_transfer_id` / `failure_reason`. A step
 * whose instant is not stored anywhere gets `at: null`, which the UI renders as
 * "—". Nothing here derives a date from another date.
 */
import type { VendorPayout } from "@/lib/vendor-payouts";

export type VendorPayoutTimelineStepId = "approved" | "created" | "transfer" | "outcome";
export type VendorPayoutTimelineState = "done" | "pending" | "failed" | "skipped";

export type VendorPayoutTimelineStep = {
  id: VendorPayoutTimelineStepId;
  label: string;
  state: VendorPayoutTimelineState;
  /** ISO instant the step happened, or null when no stored record says when. */
  at: string | null;
  /** Stripe transfer id, the failure reason Stripe gave, why a payout was skipped. */
  detail: string | null;
};

export type VendorPayoutTimelinePayout = Pick<
  VendorPayout,
  "status" | "amountCents" | "stripeTransferId" | "failureReason" | "createdAt"
> & { updatedAt?: string | null };

export type VendorPayoutTimelineInput = {
  payout: VendorPayoutTimelinePayout;
  /** The work order the payout is for. `paidAt` is the manager's approve-and-pay instant. */
  workOrder?: { paidAt?: string | null } | null;
  /** The vendor invoice for that work order, when the vendor submitted one. */
  invoice?: { status: string; decidedAt: string | null } | null;
};

const INVOICE_APPROVED_STATUSES = new Set(["approved", "scheduled", "paid"]);

function isoOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return Number.isNaN(new Date(trimmed).getTime()) ? null : trimmed;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Map one payout (plus the work order / invoice it belongs to) to its timeline steps, in order. */
export function vendorPayoutTimeline(input: VendorPayoutTimelineInput): VendorPayoutTimelineStep[] {
  const { payout, workOrder, invoice } = input;

  const invoiceApprovedAt =
    invoice && INVOICE_APPROVED_STATUSES.has(invoice.status) ? isoOrNull(invoice.decidedAt) : null;
  const approved: VendorPayoutTimelineStep = {
    id: "approved",
    label: "Invoice approved",
    state: "done",
    at: invoiceApprovedAt ?? isoOrNull(workOrder?.paidAt),
    detail: invoiceApprovedAt ? "Invoice approved by the manager" : "Approved and marked paid by the manager",
  };

  const created: VendorPayoutTimelineStep = {
    id: "created",
    label: "Payout created",
    state: "done",
    at: isoOrNull(payout.createdAt),
    detail: payout.amountCents > 0 ? `${formatCents(payout.amountCents)} to your connected bank account` : null,
  };

  const settledAt = isoOrNull(payout.updatedAt);
  const transferId = payout.stripeTransferId?.trim() || null;

  let transfer: VendorPayoutTimelineStep;
  let outcome: VendorPayoutTimelineStep;
  switch (payout.status) {
    case "paid":
      transfer = {
        id: "transfer",
        label: "Transfer sent",
        state: "done",
        at: settledAt,
        detail: transferId ? `Stripe transfer ${transferId}` : null,
      };
      outcome = {
        id: "outcome",
        label: "Paid out",
        state: "done",
        at: settledAt,
        detail: "Sent to your connected bank account",
      };
      break;
    case "failed":
      transfer = { id: "transfer", label: "Transfer sent", state: "failed", at: null, detail: "Not sent" };
      outcome = {
        id: "outcome",
        label: "Payout failed",
        state: "failed",
        at: settledAt,
        detail: payout.failureReason?.trim() || "Stripe did not give a reason.",
      };
      break;
    case "skipped":
      transfer = { id: "transfer", label: "Transfer sent", state: "skipped", at: null, detail: "Not attempted" };
      outcome = {
        id: "outcome",
        label: "Payout skipped",
        state: "skipped",
        at: settledAt,
        detail: payout.failureReason?.trim() || "No transfer was attempted for this job.",
      };
      break;
    default:
      transfer = { id: "transfer", label: "Transfer sent", state: "pending", at: null, detail: "Waiting on Stripe" };
      outcome = { id: "outcome", label: "Payout pending", state: "pending", at: null, detail: "Transfer in progress" };
  }

  return [approved, created, transfer, outcome];
}
