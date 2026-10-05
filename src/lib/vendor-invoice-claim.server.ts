import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export type VendorInvoicePaymentRail = "stripe" | "balance" | "offline";

/**
 * Hands a payment claim back when NO money moved — the one owner of that undo, shared by every
 * rail that claims before charging (`claim_vendor_invoice_payment`). A claim left behind had the
 * RPC reject every other rail, so the invoice could no longer be paid, scheduled or deleted at
 * all.
 *
 * The invoice row is the authority on who holds the claim, so giving it up is a compare-and-swap
 * on `payment_claim` (and, when the caller knows it, on the `checkout_session_id` that took it):
 * only the rail and attempt actually holding the claim may release it. A stale or replayed event
 * for an abandoned attempt is a no-op, instead of freeing a claim a live payment is holding.
 *
 * The pending `vendor_payouts` row is swept only once NOTHING holds the invoice and it is unpaid.
 * Deleting it unconditionally crossed rails: a replayed `stripe` expiry wiped the balance rail's
 * pending payout while leaving `payment_claim = 'balance'`, and `settle_vendor_invoice_payment`
 * then flipped zero rows — the payout record vanished and Approve + pay stopped being blocked.
 * Sweeping on a re-read rather than on the swap's own result also makes a retry self-healing when
 * the swap landed but the delete did not.
 *
 * Returns whether THIS caller's claim was the one released.
 *
 * Deliberately dependency-free: the rails that call it are heavily mocked in tests, and a release
 * that disappears behind a module mock is a stranded claim nobody notices.
 */
export async function releaseInvoicePaymentClaim(
  db: SupabaseClient,
  managerId: string,
  invoiceId: string,
  rail: VendorInvoicePaymentRail,
  opts: { checkoutSessionId?: string | null } = {},
): Promise<boolean> {
  let swap = db
    .from("vendor_invoices")
    .update({ payment_claim: null, checkout_session_id: null, updated_at: new Date().toISOString() })
    .eq("id", invoiceId)
    .eq("manager_user_id", managerId)
    .eq("payment_claim", rail)
    .neq("status", "paid");
  if (opts.checkoutSessionId) swap = swap.eq("checkout_session_id", opts.checkoutSessionId);
  const { data: released } = await swap.select("id").maybeSingle();

  const { data: current } = await db
    .from("vendor_invoices")
    .select("payment_claim, status")
    .eq("id", invoiceId)
    .eq("manager_user_id", managerId)
    .maybeSingle();
  const invoice = (current ?? null) as { payment_claim?: string | null; status?: string } | null;
  const claimIsFree = Boolean(invoice) && invoice!.payment_claim == null && invoice!.status !== "paid";
  if (claimIsFree) {
    await db
      .from("vendor_payouts")
      .delete()
      .eq("invoice_id", invoiceId)
      .eq("manager_user_id", managerId)
      .eq("status", "pending");
  }
  return Boolean((released as { id?: unknown } | null)?.id);
}

/** The pending claim row for this invoice — the claim's identity, so one Stripe session owns one claim. */
export async function readInvoicePaymentClaimId(
  db: SupabaseClient,
  managerId: string,
  invoiceId: string,
): Promise<string | null> {
  const { data } = await db
    .from("vendor_payouts")
    .select("id")
    .eq("invoice_id", invoiceId)
    .eq("manager_user_id", managerId)
    .eq("status", "pending")
    .maybeSingle();
  const id = (data as { id?: unknown } | null)?.id;
  return id == null ? null : String(id);
}
