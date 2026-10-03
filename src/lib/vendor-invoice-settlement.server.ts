import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { postGlBillPaid } from "@/lib/reports/gl-posting";
import { createBillFromVendorInvoice } from "@/lib/manager-bills.server";
import { resolveActiveWorkspaceRowScope, rowAllowedInWorkspaceScope } from "@/lib/workspaces/row-scope.server";

export async function authorizeOutgoingInvoice(db: SupabaseClient, managerId: string, invoiceId: string) {
  const { data: invoice, error } = await db.from("vendor_invoices").select("*").eq("id", invoiceId).eq("manager_user_id", managerId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!invoice || invoice.voided_at || !invoice.work_order_id) throw new Error("Invoice not found.");
  const { data: service, error: serviceError } = await db.from("portal_work_order_records").select("property_id, vendor_user_id").eq("id", invoice.work_order_id).eq("manager_user_id", managerId).maybeSingle();
  if (serviceError) throw new Error(serviceError.message);
  const scope = await resolveActiveWorkspaceRowScope(db, managerId);
  if (!service || !rowAllowedInWorkspaceScope(scope, service.property_id)) throw new Error("Invoice not found.");
  if (invoice.status !== "paid" && service.vendor_user_id !== invoice.vendor_user_id) throw new Error("Service must be assigned to this vendor.");
  return invoice;
}
export async function claimInvoicePayment(db: SupabaseClient, managerId: string, invoiceId: string, rail: "stripe" | "balance" | "offline") {
  const invoice = await authorizeOutgoingInvoice(db, managerId, invoiceId);
  if (invoice.status === "approved") await createBillFromVendorInvoice(db, managerId, invoiceId);
  const { error } = await db.rpc("claim_vendor_invoice_payment", { p_invoice: invoiceId, p_manager: managerId, p_rail: rail });
  if (error) throw new Error(error.message);
  return invoice;
}
/** Atomic bookkeeping; GL posting is idempotent and retried even after invoice is paid. */
export async function settleInvoicePayment(db: SupabaseClient, managerId: string, invoiceId: string, rail: "stripe" | "balance" | "offline", paidAt = new Date().toISOString(), method: string | null = null) {
  const { data: billId, error } = await db.rpc("settle_vendor_invoice_payment", { p_invoice: invoiceId, p_manager: managerId, p_rail: rail, p_paid_at: paidAt, p_method: method });
  if (error) throw new Error(error.message);
  const { data: bill, error: billError } = await db.from("manager_bills").select("*").eq("id", billId).eq("manager_user_id", managerId).single();
  if (billError || !bill) throw new Error(billError?.message || "Bill not found.");
  await postGlBillPaid(db, { managerUserId: managerId, billId: bill.id, amountCents: bill.amount_cents, entryDate: String(bill.paid_at).slice(0,10), propertyId: bill.property_id, vendorId: bill.vendor_id, categoryCode: bill.category_code, memo: bill.description });
}
