import type { VendorInvoice } from "@/lib/vendor-invoices";
import { isVisitFeeInvoiceNumber } from "@/lib/work-order-visit-fee";

export type OutgoingInvoice = VendorInvoice & { vendorUserId: string; vendorName: string; serviceTitle?: string; propertyName?: string };
/** Historical payments stay visible even after a service is reassigned. */
export function invoiceBelongsInOutgoing(invoice: Pick<OutgoingInvoice, "status" | "workOrderId" | "vendorUserId"> & { invoiceNumber?: string | null }, assignedVendorUserId: string | null): boolean {
  if (invoice.status === "paid") return true;
  // An estimate-visit fee is owed whether or not that vendor was the one hired.
  if (isVisitFeeInvoiceNumber(invoice.invoiceNumber)) return invoice.status === "approved" || invoice.status === "scheduled";
  return (invoice.status === "approved" || invoice.status === "scheduled") &&
    Boolean(invoice.workOrderId && assignedVendorUserId && assignedVendorUserId === invoice.vendorUserId);
}
export function outgoingInvoiceTotals(invoices: OutgoingInvoice[], year: number) {
  const vendorIds = new Set<string>();
  const totals = invoices.reduce((totals, invoice) => {
    if (!Number.isSafeInteger(invoice.totalCents) || invoice.totalCents < 0) throw new Error("Invalid invoice amount.");
    if (invoice.status === "approved" || invoice.status === "scheduled") {
      totals.owedCents += invoice.totalCents;
      totals.billCount += 1;
      vendorIds.add(invoice.vendorUserId);
    }
    if (invoice.status === "paid" && invoice.paidAt?.slice(0, 4) === String(year)) totals.paidThisYearCents += invoice.totalCents;
    if (!Number.isSafeInteger(totals.owedCents) || !Number.isSafeInteger(totals.paidThisYearCents)) throw new Error("Invoice totals exceed the supported amount.");
    return totals;
  }, { owedCents: 0, paidThisYearCents: 0, billCount: 0 });
  return { ...totals, vendorCount: vendorIds.size };
}
