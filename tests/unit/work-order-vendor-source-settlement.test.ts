import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/stripe", () => ({ getStripe: () => ({}) }));
vi.mock("@/lib/vendor-captured-source.server", () => ({
  creditVerifiedVendorCheckoutSource: vi.fn(async () => {
    calls.push("source");
    return { holdId: "hold_1", chargeId: "ch_1", recipientNetCents: 9700 };
  }),
}));
vi.mock("@/lib/stripe-vendor-payout", () => ({
  payoutVendorForWorkOrder: vi.fn(),
  recordVendorPayoutSettled: vi.fn(async () => { calls.push("payout"); }),
}));
vi.mock("@/lib/vendor-banking/ledger.server", () => ({
  recordVendorBankingChargeAndFee: vi.fn(async () => { calls.push("fee"); }),
}));
vi.mock("@/lib/platform-hold-release.server", () => ({
  releaseVerifiedPlatformHoldsForOwner: vi.fn(async () => { calls.push("release"); }),
}));
vi.mock("@/lib/stripe-platform-hold.server", () => ({
  creditHoldFromPaidSession: vi.fn(async () => { throw new Error("raw hold used"); }),
}));

import { completeVendorPayFromStripeSession } from "@/lib/work-order-approve-pay.server";
import { creditVerifiedVendorCheckoutSource } from "@/lib/vendor-captured-source.server";
import { recordVendorPayoutSettled } from "@/lib/stripe-vendor-payout";

const frozen = {
  managerUserId: "manager", vendorUserId: "vendor", invoiceCents: 10000,
  platformFeeCents: 300,
  request: {
    idempotencyKey: "work-order:wo_1:attempt:one", amountCents: 10000,
    destinationAccountId: null, paymentMethod: "ach", forceExplicitCard: false,
    extraApplicationFeeCents: 300,
    fixedFeeBreakdown: { residentAddedFeeCents: 100, totalCents: 10100 },
    metadata: { source_arbitration_v: "1", checkout_attempt: "attempt:one", platform_fee_cents: "300" },
  },
};
const session = {
  id: "cs_1", status: "complete", payment_status: "paid", currency: "usd", amount_total: 10100,
  metadata: {
    purpose: "vendor_invoice_pay", work_order_id: "wo_1", manager_user_id: "manager",
    vendor_user_id: "vendor", invoice_cents: "10000", processing_fee_cents: "100",
    platform_fee_cents: "300", payment_method: "ach", platform_hold: "1",
    source_arbitration_v: "1", checkout_attempt: "attempt:one",
  },
};
function dbWithPending(providerTerms: unknown = frozen) {
  return { from: (table: string) => {
    expect(table).toBe("portal_work_order_records");
    const query = {
      select: () => query, eq: () => query,
      maybeSingle: async () => ({ data: {
        manager_user_id: "manager", vendor_user_id: "vendor",
        row_data: { automationStatus: "paid", paidAt: "2026-10-04T00:00:00Z",
          pendingVendorPay: { sessionId: "cs_1", vendorCostCents: 10000, providerTerms } },
      }, error: null }),
    };
    return query;
  } };
}

describe("marked service Checkout settlement", () => {
  beforeEach(() => { calls.length = 0; vi.clearAllMocks(); });

  it("verifies captured source before binding the payout, fee, and residual release", async () => {
    await completeVendorPayFromStripeSession(dbWithPending() as never, session as never);
    expect(calls).toEqual(["source", "payout", "fee", "release"]);
    expect(vi.mocked(recordVendorPayoutSettled)).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ platformHoldId: "hold_1", stripeChargeId: "ch_1",
        destination: "hold", platformFeeCents: 300 }));
  });

  it("rejects a paid session without its immutable provider claim before mutation", async () => {
    await expect(completeVendorPayFromStripeSession(dbWithPending(null) as never, session as never))
      .rejects.toThrow("frozen provider claim");
    expect(vi.mocked(creditVerifiedVendorCheckoutSource)).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});
