import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export type VendorInvoicePaymentRail = "stripe" | "balance" | "offline";

/**
 * Hands a payment claim back when NO money moved — the one owner of that undo, shared by every
 * rail that claims before charging (`claim_vendor_invoice_payment`). A claim left behind had the
 * RPC reject every other rail, so the invoice could no longer be paid, scheduled or deleted at
 * all. Only an unpaid invoice still claimed by THIS rail is released, so it can never undo a
 * settled payment.
 *
 * Deliberately dependency-free: the rails that call it are heavily mocked in tests, and a release
 * that disappears behind a module mock is a stranded claim nobody notices.
 */
export async function releaseInvoicePaymentClaim(
  db: SupabaseClient,
  managerId: string,
  invoiceId: string,
  rail: VendorInvoicePaymentRail,
): Promise<void> {
  await db
    .from("vendor_payouts")
    .delete()
    .eq("invoice_id", invoiceId)
    .eq("manager_user_id", managerId)
    .eq("status", "pending");
  await db
    .from("vendor_invoices")
    .update({ payment_claim: null, updated_at: new Date().toISOString() })
    .eq("id", invoiceId)
    .eq("manager_user_id", managerId)
    .eq("payment_claim", rail)
    .neq("status", "paid");
}
