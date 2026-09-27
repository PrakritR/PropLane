// C161 — the invoice detail's overview tab gets a Submitted → Approved →
// Scheduled → Paid timeline instead of a plain "$total · status" line, with
// Rejected as its own short terminal branch.
import { describe, expect, it } from "vitest";
import { vendorInvoiceTimeline, type VendorInvoice } from "@/lib/vendor-invoices";

function invoice(overrides: Partial<VendorInvoice>): Pick<VendorInvoice, "status" | "submittedAt" | "decidedAt" | "paidAt" | "decisionNote"> {
  return {
    status: "submitted",
    submittedAt: "2026-01-01T00:00:00.000Z",
    decidedAt: null,
    paidAt: null,
    decisionNote: null,
    ...overrides,
  };
}

describe("vendorInvoiceTimeline", () => {
  it("a submitted invoice has only Submitted done, everything else pending", () => {
    const steps = vendorInvoiceTimeline(invoice({}));
    expect(steps.map((s) => s.id)).toEqual(["submitted", "approved", "scheduled", "paid"]);
    expect(steps[0]).toMatchObject({ state: "done", at: "2026-01-01T00:00:00.000Z" });
    expect(steps[1]).toMatchObject({ state: "pending", at: null });
    expect(steps[2]).toMatchObject({ state: "pending", at: null });
    expect(steps[3]).toMatchObject({ state: "pending", at: null });
  });

  it("an approved invoice shows its own decided_at on the Approved step", () => {
    const steps = vendorInvoiceTimeline(invoice({ status: "approved", decidedAt: "2026-01-02T00:00:00.000Z" }));
    expect(steps[1]).toMatchObject({ id: "approved", state: "done", at: "2026-01-02T00:00:00.000Z" });
    expect(steps[2]).toMatchObject({ id: "scheduled", state: "pending", at: null });
  });

  it("a scheduled invoice's Approved date is unknown (decided_at was overwritten) but Scheduled has it", () => {
    const steps = vendorInvoiceTimeline(invoice({ status: "scheduled", decidedAt: "2026-01-03T00:00:00.000Z" }));
    expect(steps[1]).toMatchObject({ id: "approved", state: "done", at: null });
    expect(steps[2]).toMatchObject({ id: "scheduled", state: "done", at: "2026-01-03T00:00:00.000Z" });
    expect(steps[3]).toMatchObject({ id: "paid", state: "pending", at: null });
  });

  it("a paid invoice never guesses whether Scheduled happened", () => {
    const steps = vendorInvoiceTimeline(invoice({ status: "paid", decidedAt: "2026-01-04T00:00:00.000Z", paidAt: "2026-01-05T00:00:00.000Z" }));
    expect(steps[1]).toMatchObject({ id: "approved", state: "done", at: null });
    expect(steps[2]).toMatchObject({ id: "scheduled", state: "skipped", at: null });
    expect(steps[3]).toMatchObject({ id: "paid", state: "done", at: "2026-01-05T00:00:00.000Z" });
  });

  it("a rejected invoice is a short Submitted → Rejected branch, not a fake continuation", () => {
    const steps = vendorInvoiceTimeline(
      invoice({ status: "rejected", decidedAt: "2026-01-02T00:00:00.000Z", decisionNote: "Missing receipts" }),
    );
    expect(steps.map((s) => s.id)).toEqual(["submitted", "rejected"]);
    expect(steps[1]).toMatchObject({ state: "failed", at: "2026-01-02T00:00:00.000Z", detail: "Missing receipts" });
  });
});
