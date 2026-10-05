import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { postGlBillPaid } from "@/lib/reports/gl-posting";
import { createBillFromVendorInvoice } from "@/lib/manager-bills.server";
import { isGenuineVisitFeeInvoice } from "@/lib/work-order-visit-fee-invoice.server";
import { findBlockingVendorPayout } from "@/lib/work-order-approve-pay.server";
import { existingVendorPayoutWarning } from "@/lib/vendor-payout-guard";
import { resolveActiveWorkspaceRowScope, rowAllowedInWorkspaceScope } from "@/lib/workspaces/row-scope.server";
import { isVendorInvoiceRefusalSqlState, VendorInvoicePaymentRefusal } from "@/lib/vendor-invoices";

export async function authorizeOutgoingInvoice(db: SupabaseClient, managerId: string, invoiceId: string) {
  const { data: invoice, error } = await db.from("vendor_invoices").select("*").eq("id", invoiceId).eq("manager_user_id", managerId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!invoice || invoice.voided_at || !invoice.work_order_id) throw new VendorInvoicePaymentRefusal("Invoice not found.");
  const { data: service, error: serviceError } = await db.from("portal_work_order_records").select("property_id, vendor_user_id").eq("id", invoice.work_order_id).eq("manager_user_id", managerId).maybeSingle();
  if (serviceError) throw new Error(serviceError.message);
  const scope = await resolveActiveWorkspaceRowScope(db, managerId);
  if (!service || !rowAllowedInWorkspaceScope(scope, service.property_id)) throw new VendorInvoicePaymentRefusal("Invoice not found.");
  // An estimate-visit fee is owed to a vendor who was never hired for the job, so it is exempt from
  // the "assigned to this vendor" rule - but only when it matches a real bid whose visit happened.
  if (invoice.status !== "paid" && service.vendor_user_id !== invoice.vendor_user_id && !(await isGenuineVisitFeeInvoice(db, invoice))) {
    throw new VendorInvoicePaymentRefusal("Service must be assigned to this vendor.");
  }
  return invoice;
}
/**
 * The friendly half of the cross-rail double-pay guard, shared by every invoice rail (offline,
 * balance, Stripe): refuse when ANOTHER payout (Approve + pay, or a second job invoice) already
 * moved or is moving money for this job. A refusal is a `VendorInvoicePaymentRefusal`; a payout
 * table that could not be READ is a plain Error, because a rail must answer 409 for the first and
 * 500 for the second. An estimate-visit-fee invoice is a separate bill and is
 * exempt, and the invoice's own claim row never blocks its own retry. This is a read-then-write
 * pre-check; the database arbitrates the race (`claim_vendor_invoice_payment` and the
 * `vendor_payouts_cross_rail_guard` trigger, migration 20261004160000).
 */
export async function assertNoCrossRailPayout(
  db: SupabaseClient,
  invoice: { id: string; work_order_id?: string | null; estimate_visit_bid_id?: string | null },
): Promise<void> {
  const workOrderId = invoice.work_order_id?.trim();
  if (!workOrderId || invoice.estimate_visit_bid_id != null) return;
  const blocking = await findBlockingVendorPayout(db, workOrderId, { excludeInvoiceId: invoice.id });
  if (!blocking.ok) throw new Error(blocking.error);
  if (blocking.payout) throw new VendorInvoicePaymentRefusal(existingVendorPayoutWarning(blocking.payout));
}
export async function claimInvoicePayment(db: SupabaseClient, managerId: string, invoiceId: string, rail: "stripe" | "balance" | "offline") {
  const invoice = await authorizeOutgoingInvoice(db, managerId, invoiceId);
  await assertNoCrossRailPayout(db, invoice);
  if (invoice.status === "approved") await createBillFromVendorInvoice(db, managerId, invoiceId);
  const { error } = await db.rpc("claim_vendor_invoice_payment", { p_invoice: invoiceId, p_manager: managerId, p_rail: rail });
  if (error) {
    if (isVendorInvoiceRefusalSqlState(error.code)) throw new VendorInvoicePaymentRefusal(error.message);
    throw new Error(error.message);
  }
  return invoice;
}
/** Atomic bookkeeping; GL posting is idempotent and retried even after invoice is paid. */
export async function settleInvoicePayment(db: SupabaseClient, managerId: string, invoiceId: string, rail: "stripe" | "balance" | "offline", paidAt = new Date().toISOString(), method: string | null = null) {
  const { data: billId, error } = await db.rpc("settle_vendor_invoice_payment", { p_invoice: invoiceId, p_manager: managerId, p_rail: rail, p_paid_at: paidAt, p_method: method });
  if (error) {
    if (isVendorInvoiceRefusalSqlState(error.code)) throw new VendorInvoicePaymentRefusal(error.message);
    throw new Error(error.message);
  }
  const { data: bill, error: billError } = await db.from("manager_bills").select("*").eq("id", billId).eq("manager_user_id", managerId).single();
  if (billError || !bill) throw new Error(billError?.message || "Bill not found.");
  await postGlBillPaid(db, { managerUserId: managerId, billId: bill.id, amountCents: bill.amount_cents, entryDate: String(bill.paid_at).slice(0,10), propertyId: bill.property_id, vendorId: bill.vendor_id, categoryCode: bill.category_code, memo: bill.description });
}
