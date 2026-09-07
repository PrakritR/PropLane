import { describe, expect, it } from "vitest";
import { vendorPayoutTimeline } from "@/lib/vendor-payout-timeline";

const basePayout = {
  amountCents: 12_500,
  stripeTransferId: null as string | null,
  failureReason: null as string | null,
  createdAt: "2026-09-01T17:00:00.000Z",
  updatedAt: "2026-09-01T17:00:04.000Z" as string | null,
};

describe("vendorPayoutTimeline", () => {
  it("maps a paid payout to four done steps with the transfer id and stored instants", () => {
    const steps = vendorPayoutTimeline({
      payout: { ...basePayout, status: "paid", stripeTransferId: "tr_123" },
      workOrder: { paidAt: "2026-09-01T16:59:00.000Z" },
    });
    expect(steps.map((s) => s.id)).toEqual(["approved", "created", "transfer", "outcome"]);
    expect(steps.map((s) => s.state)).toEqual(["done", "done", "done", "done"]);
    expect(steps[0]).toMatchObject({ label: "Invoice approved", at: "2026-09-01T16:59:00.000Z" });
    expect(steps[1]).toMatchObject({
      label: "Payout created",
      at: "2026-09-01T17:00:00.000Z",
      detail: "$125.00 to your connected bank account",
    });
    expect(steps[2]).toMatchObject({
      label: "Transfer sent",
      at: "2026-09-01T17:00:04.000Z",
      detail: "Stripe transfer tr_123",
    });
    expect(steps[3]).toMatchObject({ label: "Paid out", at: "2026-09-01T17:00:04.000Z" });
  });

  it("prefers the invoice's decided_at for the approval step when the manager approved an invoice", () => {
    const steps = vendorPayoutTimeline({
      payout: { ...basePayout, status: "paid", stripeTransferId: "tr_1" },
      workOrder: { paidAt: "2026-09-01T16:59:00.000Z" },
      invoice: { status: "approved", decidedAt: "2026-08-30T12:00:00.000Z" },
    });
    expect(steps[0]).toMatchObject({ at: "2026-08-30T12:00:00.000Z", detail: "Invoice approved by the manager" });
  });

  it("ignores a rejected or undecided invoice and falls back to the work order's paidAt", () => {
    const steps = vendorPayoutTimeline({
      payout: { ...basePayout, status: "paid" },
      workOrder: { paidAt: "2026-09-01T16:59:00.000Z" },
      invoice: { status: "rejected", decidedAt: "2026-08-30T12:00:00.000Z" },
    });
    expect(steps[0].at).toBe("2026-09-01T16:59:00.000Z");
    const undecided = vendorPayoutTimeline({
      payout: { ...basePayout, status: "paid" },
      invoice: { status: "submitted", decidedAt: null },
    });
    expect(undecided[0].at).toBeNull();
  });

  it("marks a failed payout: transfer not sent, outcome failed with Stripe's reason at the row's updated_at", () => {
    const steps = vendorPayoutTimeline({
      payout: { ...basePayout, status: "failed", failureReason: "Vendor has not connected a Stripe payout account yet." },
    });
    expect(steps[2]).toMatchObject({ state: "failed", at: null, detail: "Not sent" });
    expect(steps[3]).toMatchObject({
      label: "Payout failed",
      state: "failed",
      at: "2026-09-01T17:00:04.000Z",
      detail: "Vendor has not connected a Stripe payout account yet.",
    });
  });

  it("marks a skipped payout with why it was skipped, and a placeholder when no reason was stored", () => {
    const withReason = vendorPayoutTimeline({
      payout: { ...basePayout, status: "skipped", failureReason: "No accepted bid to anchor the amount." },
    });
    expect(withReason[2]).toMatchObject({ state: "skipped", at: null, detail: "Not attempted" });
    expect(withReason[3]).toMatchObject({
      label: "Payout skipped",
      state: "skipped",
      detail: "No accepted bid to anchor the amount.",
    });
    const noReason = vendorPayoutTimeline({ payout: { ...basePayout, status: "skipped" } });
    expect(noReason[3].detail).toBe("No transfer was attempted for this job.");
  });

  it("renders a pending claim as in-flight with no invented instants", () => {
    const steps = vendorPayoutTimeline({ payout: { ...basePayout, status: "pending", updatedAt: null } });
    expect(steps[2]).toMatchObject({ state: "pending", at: null });
    expect(steps[3]).toMatchObject({ label: "Payout pending", state: "pending", at: null });
  });

  it("never guesses a date: unknown, blank, or unparseable instants become null", () => {
    const steps = vendorPayoutTimeline({
      payout: { ...basePayout, status: "paid", stripeTransferId: "tr_9", createdAt: "not-a-date", updatedAt: undefined },
      workOrder: { paidAt: "   " },
    });
    expect(steps.map((s) => s.at)).toEqual([null, null, null, null]);
    expect(steps[2].detail).toBe("Stripe transfer tr_9");
  });
});
