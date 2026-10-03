import type { VendorInvoice } from "@/lib/vendor-invoices";

export type OutgoingInvoice = VendorInvoice & { vendorUserId: string; vendorName: string; serviceTitle?: string; propertyName?: string };
/** Historical payments stay visible even after a service is reassigned. */
export function invoiceBelongsInOutgoing(invoice: Pick<OutgoingInvoice, "status" | "workOrderId" | "vendorUserId">, assignedVendorUserId: string | null): boolean {
  if (invoice.status === "paid") return true;
  return (invoice.status === "approved" || invoice.status === "scheduled") &&
    (!invoice.workOrderId || Boolean(assignedVendorUserId && assignedVendorUserId === invoice.vendorUserId));
}
export function outgoingInvoiceTotals(invoices: OutgoingInvoice[], year: number) {
  return invoices.reduce((totals, invoice) => {
    if (!Number.isSafeInteger(invoice.totalCents) || invoice.totalCents < 0) throw new Error("Invalid invoice amount.");
    if (invoice.status === "approved" || invoice.status === "scheduled") totals.owedCents += invoice.totalCents;
    if (invoice.status === "paid" && invoice.paidAt?.slice(0, 4) === String(year)) totals.paidThisYearCents += invoice.totalCents;
    if (!Number.isSafeInteger(totals.owedCents) || !Number.isSafeInteger(totals.paidThisYearCents)) throw new Error("Invoice totals exceed the supported amount.");
    return totals;
  }, { owedCents: 0, paidThisYearCents: 0 });
}
