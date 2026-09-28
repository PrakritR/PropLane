import { describe, expect, it } from "vitest";
import { vendorPaymentDetailBreakdown, vendorPaymentStatusTimeline } from "@/lib/vendor-payments";
import type { VendorPayout } from "@/lib/vendor-payouts";

function payout(overrides: Partial<VendorPayout> = {}): VendorPayout {
  return {
    id: "payout_1",
    workOrderId: "wo_1",
    invoiceId: null,
    amountCents: 10_000,
    stripeTransferId: "tr_1",
    status: "paid",
    failureReason: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:05:00.000Z",
    platformFeeCents: 300,
    refundedGrossCents: 0,
    refundedFeeCents: 0,
    destination: "destination_charge",
    ...overrides,
  };
}

describe("vendorPaymentDetailBreakdown (VD53)", () => {
  it("computes gross / fee / net for a fee-bearing payment", () => {
    expect(vendorPaymentDetailBreakdown(payout())).toEqual({
      grossCents: 10_000,
      feeCents: 300,
      netCents: 9_700,
      refundedGrossCents: 0,
    });
  });

  it("never reports a fee greater than gross (rounding/legacy safety)", () => {
    const result = vendorPaymentDetailBreakdown(payout({ amountCents: 100, platformFeeCents: 9_999 }));
    expect(result.feeCents).toBeLessThanOrEqual(result.grossCents);
    expect(result.netCents).toBe(0);
  });

  it("never reports a negative figure for a legacy (pre-flag) row with no fee/refund columns", () => {
    const result = vendorPaymentDetailBreakdown(payout({ platformFeeCents: undefined, refundedGrossCents: undefined }));
    expect(result.feeCents).toBe(0);
    expect(result.netCents).toBe(10_000);
    expect(result.refundedGrossCents).toBe(0);
  });

  it("caps reported refunded amount at gross", () => {
    const result = vendorPaymentDetailBreakdown(payout({ refundedGrossCents: 50_000 }));
    expect(result.refundedGrossCents).toBe(10_000);
  });

  it("carries a real partial refund through untouched", () => {
    const result = vendorPaymentDetailBreakdown(payout({ refundedGrossCents: 4_000 }));
    expect(result.refundedGrossCents).toBe(4_000);
  });
});

describe("vendorPaymentStatusTimeline (VD52)", () => {
  it("a pending payment has done nothing yet", () => {
    const steps = vendorPaymentStatusTimeline(payout({ status: "pending" }), { bankReady: true });
    expect(steps.map((s) => s.state)).toEqual(["pending", "pending", "pending", "pending"]);
  });

  it("a destination-charge payment is paid, held, and transferred immediately", () => {
    const steps = vendorPaymentStatusTimeline(payout({ destination: "destination_charge" }), { bankReady: false });
    expect(steps.find((s) => s.id === "paid")?.state).toBe("done");
    expect(steps.find((s) => s.id === "held")?.state).toBe("done");
    expect(steps.find((s) => s.id === "transferred")?.state).toBe("done");
    expect(steps.find((s) => s.id === "withdrawn")?.state).toBe("pending");
  });

  it("a held payment stays at 'transferred: pending' until the vendor's bank is ready", () => {
    const steps = vendorPaymentStatusTimeline(payout({ destination: "hold" }), { bankReady: false });
    expect(steps.find((s) => s.id === "transferred")?.state).toBe("pending");
  });

  it("a held payment clears to transferred once the bank is ready (existing auto-transfer)", () => {
    const steps = vendorPaymentStatusTimeline(payout({ destination: "hold" }), { bankReady: true });
    expect(steps.find((s) => s.id === "transferred")?.state).toBe("done");
  });

  it("a legacy row with no destination column is treated as held (never over-claims transferred)", () => {
    const steps = vendorPaymentStatusTimeline(payout({ destination: null }), { bankReady: false });
    expect(steps.find((s) => s.id === "transferred")?.state).toBe("pending");
  });

  it("marks withdrawn only when a real later withdrawal exists", () => {
    const notYet = vendorPaymentStatusTimeline(payout(), { bankReady: true, lastWithdrawalAt: null });
    expect(notYet.find((s) => s.id === "withdrawn")?.state).toBe("pending");

    const before = vendorPaymentStatusTimeline(payout(), { bankReady: true, lastWithdrawalAt: "2026-08-01T00:00:00.000Z" });
    expect(before.find((s) => s.id === "withdrawn")?.state).toBe("pending");

    const after = vendorPaymentStatusTimeline(payout(), { bankReady: true, lastWithdrawalAt: "2026-09-02T00:00:00.000Z" });
    expect(after.find((s) => s.id === "withdrawn")?.state).toBe("done");
  });
});
