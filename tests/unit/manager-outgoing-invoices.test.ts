import { describe, expect, it } from "vitest";
import { invoiceBelongsInOutgoing, outgoingInvoiceTotals, type OutgoingInvoice } from "@/lib/manager-outgoing-invoices";

describe("outgoing invoice eligibility", () => {
  const invoice = { status: "approved" as const, workOrderId: "service", vendorUserId: "vendor" };
  it("requires approval and the same assigned vendor for unpaid service invoices", () => {
    expect(invoiceBelongsInOutgoing(invoice, "vendor")).toBe(true);
    expect(invoiceBelongsInOutgoing(invoice, null)).toBe(false);
    expect(invoiceBelongsInOutgoing(invoice, "other-vendor")).toBe(false);
    expect(invoiceBelongsInOutgoing({ ...invoice, status: "submitted" }, "vendor")).toBe(false);
    expect(invoiceBelongsInOutgoing({ ...invoice, status: "rejected" }, "vendor")).toBe(false);
  });
  it("retains historical paid invoices but excludes unlinked unpaid bills", () => {
    expect(invoiceBelongsInOutgoing({ ...invoice, status: "paid" }, null)).toBe(true);
    expect(invoiceBelongsInOutgoing({ ...invoice, workOrderId: null }, null)).toBe(false);
  });
  it("sums cents without counting unapproved invoices or other years", () => {
    const rows = [
      { status: "approved", totalCents: 101, vendorUserId: "one" },
      { status: "scheduled", totalCents: 202, vendorUserId: "one" },
      { status: "submitted", totalCents: 10000 },
      { status: "paid", totalCents: 303, paidAt: "2026-01-01" },
      { status: "paid", totalCents: 400, paidAt: "2025-12-31" },
    ] as OutgoingInvoice[];
    expect(outgoingInvoiceTotals(rows, 2026)).toEqual({ owedCents: 303, paidThisYearCents: 303, billCount: 2, vendorCount: 1 });
  });
});
