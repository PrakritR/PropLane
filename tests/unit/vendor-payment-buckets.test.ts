// Vendor Payments tabs (vendor-portal-redesign-1006): Pending · Paid · Overdue.
// Overdue = an invoice past its due date and still unpaid.
import { describe, expect, it } from "vitest";
import {
  VENDOR_PAYMENT_BUCKETS,
  buildVendorPaymentRows,
  filterVendorPaymentRows,
  vendorPaymentBucket,
  vendorPaymentBucketCounts,
  type VendorPaymentRow,
} from "@/lib/vendor-payments";
import type { VendorInvoice } from "@/lib/vendor-invoices";

function invoice(partial: Partial<VendorInvoice> & { id: string }): VendorInvoice {
  return {
    vendorId: "v1",
    workOrderId: null,
    invoiceNumber: partial.id.toUpperCase(),
    lineItems: [],
    subtotalCents: 10000,
    taxCents: 0,
    totalCents: 10000,
    currency: "usd",
    status: "submitted",
    memo: null,
    decisionNote: null,
    billId: null,
    submittedAt: "2026-09-01T00:00:00.000Z",
    decidedAt: null,
    paidAt: null,
    paidFrom: null,
    ...partial,
  };
}

const rows = (invoices: VendorInvoice[]) => buildVendorPaymentRows([], invoices, {}, {}, {});
const TODAY = "2026-10-06";

describe("bucket rule", () => {
  it("tabs are Pending · Paid · Overdue, in that order", () => {
    expect(VENDOR_PAYMENT_BUCKETS.map((b) => b.label)).toEqual(["Pending", "Paid", "Overdue"]);
  });

  it("a paid invoice is Paid even when its due date has passed", () => {
    const [row] = rows([invoice({ id: "a", status: "paid", dueDate: "2026-09-01" })]);
    expect(vendorPaymentBucket(row!, TODAY)).toBe("paid");
  });

  it("an unpaid invoice past its due date is Overdue; due today is still Pending", () => {
    const [late] = rows([invoice({ id: "a", status: "approved", dueDate: "2026-10-05" })]);
    const [today] = rows([invoice({ id: "b", status: "approved", dueDate: TODAY })]);
    const [future] = rows([invoice({ id: "c", status: "scheduled", dueDate: "2026-10-20" })]);
    expect(vendorPaymentBucket(late!, TODAY)).toBe("overdue");
    expect(vendorPaymentBucket(today!, TODAY)).toBe("pending");
    expect(vendorPaymentBucket(future!, TODAY)).toBe("pending");
  });

  it("an invoice with no due date can never be overdue", () => {
    const [row] = rows([invoice({ id: "a", status: "approved", dueDate: null })]);
    expect(vendorPaymentBucket(row!, TODAY)).toBe("pending");
  });

  it("a rejected invoice is not 'overdue' — nothing is owed on it", () => {
    const [row] = rows([invoice({ id: "a", status: "rejected", dueDate: "2026-09-01" })]);
    expect(vendorPaymentBucket(row!, TODAY)).toBe("pending");
  });

  it("an income row follows its payout status: paid → Paid, everything else Pending", () => {
    const base = { id: "i", kind: "income", invoice: null, dueIso: null } as unknown as VendorPaymentRow;
    expect(vendorPaymentBucket({ ...base, statusId: "income:paid" }, TODAY)).toBe("paid");
    expect(vendorPaymentBucket({ ...base, statusId: "income:pending" }, TODAY)).toBe("pending");
    expect(vendorPaymentBucket({ ...base, statusId: "income:failed" }, TODAY)).toBe("pending");
  });

  it("counts every row into exactly one tab", () => {
    const all = rows([
      invoice({ id: "a", status: "paid" }),
      invoice({ id: "b", status: "approved", dueDate: "2026-09-01" }),
      invoice({ id: "c", status: "submitted" }),
      invoice({ id: "d", status: "scheduled", dueDate: "2026-12-01" }),
    ]);
    const counts = vendorPaymentBucketCounts(all, TODAY);
    expect(counts).toEqual({ pending: 2, paid: 1, overdue: 1 });
    expect(counts.pending + counts.paid + counts.overdue).toBe(all.length);
  });
});

describe("row facts the list reads", () => {
  it("names the service and the manager from the job, keeps the invoice number for search", () => {
    const job = { id: "wo1", title: "Kitchen sink leak", managerName: "Alder Property Co", propertyName: "12 Oak", unit: "—", propertyId: "p1" } as never;
    const [row] = buildVendorPaymentRows([], [invoice({ id: "inv-9", workOrderId: "wo1", invoiceNumber: "INV-9" })], { wo1: job }, {}, {});
    expect(row!.title).toBe("Kitchen sink leak");
    expect(row!.managerLabel).toBe("Alder Property Co");
    expect(row!.reference).toBe("INV-9");
    const hit = filterVendorPaymentRows([row!], { from: "", to: "", propertyIds: [], statusIds: [], query: "inv-9" });
    expect(hit).toHaveLength(1);
    const byManager = filterVendorPaymentRows([row!], { from: "", to: "", propertyIds: [], statusIds: [], query: "alder" });
    expect(byManager).toHaveLength(1);
  });

  it("an invoice with no job reads by its number and falls back to the vendor's only manager", () => {
    const [row] = buildVendorPaymentRows([], [invoice({ id: "x", invoiceNumber: "INV-7" })], {}, {}, {}, "Green Lake Rentals");
    expect(row!.title).toBe("INV-7");
    expect(row!.managerLabel).toBe("Green Lake Rentals");
  });

  it("carries the due date from the invoice", () => {
    const [row] = rows([invoice({ id: "a", dueDate: "2026-10-14T00:00:00Z" })]);
    expect(row!.dueIso).toBe("2026-10-14");
  });
});
