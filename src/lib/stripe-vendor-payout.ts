import type { SupabaseClient } from "@supabase/supabase-js";
import { getStripe } from "@/lib/stripe";
import { retrieveManagerConnectAccountOrNull, connectAccountTransfersActive } from "@/lib/stripe-connect";

/**
 * Best-effort Stripe Connect transfer of a vendor's share to their connected account when a
 * work order is approved + paid. Never throws — a Stripe failure (no account, not onboarded,
 * not configured, insufficient platform balance, etc.) is recorded as a "failed" vendor_payouts
 * row so the manager's approve-pay bookkeeping flow always succeeds regardless of payout outcome.
 *
 * Concurrency-safe: claims the payout row (status "pending") via INSERT before ever calling
 * Stripe, so the unique index on vendor_payouts.work_order_id is the sole arbiter of "who gets
 * to transfer" — two concurrent/retried calls for the same work order race the insert, and only
 * the winner proceeds to Stripe. A losing insert (or a payout that already exists in any state)
 * returns immediately with no Stripe call, never a duplicate transfer. Also passes a deterministic
 * idempotencyKey so even a Stripe-level retry of the winner's own request can't double-transfer.
 *
 * The amount is anchored to the work order's accepted bid when one exists (a vendor/manager
 * agreed amount, immune to a forged request body) and only falls back to the caller-supplied
 * amount for jobs assigned without formal bidding.
 */
export async function payoutVendorForWorkOrder(
  db: SupabaseClient,
  opts: { workOrderId: string; managerUserId: string; vendorUserId: string; amountCents: number },
): Promise<void> {
  const { data: acceptedBid } = await db
    .from("work_order_bids")
    .select("amount_cents")
    .eq("work_order_id", opts.workOrderId)
    .eq("status", "accepted")
    .maybeSingle();
  const amountCents = (acceptedBid?.amount_cents as number | null) ?? opts.amountCents;
  if (!amountCents || amountCents <= 0) return;

  const { data: claimed, error: claimError } = await db
    .from("vendor_payouts")
    .insert({
      manager_user_id: opts.managerUserId,
      vendor_user_id: opts.vendorUserId,
      work_order_id: opts.workOrderId,
      amount_cents: amountCents,
      status: "pending",
    })
    .select("id")
    .single();
  if (claimError || !claimed) return;
  const payoutId = claimed.id as string;

  const finish = (row: { status: "paid" | "failed"; stripeTransferId?: string; failureReason?: string }) =>
    db
      .from("vendor_payouts")
      .update({
        status: row.status,
        stripe_transfer_id: row.stripeTransferId ?? null,
        failure_reason: row.failureReason ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", payoutId);

  const { data: vendorProfile } = await db
    .from("profiles")
    .select("stripe_connect_account_id")
    .eq("id", opts.vendorUserId)
    .maybeSingle();
  const accountId = (vendorProfile as { stripe_connect_account_id?: string | null } | null)
    ?.stripe_connect_account_id?.trim();

  if (!accountId) {
    await finish({ status: "failed", failureReason: "Vendor has not connected a Stripe payout account yet." });
    return;
  }

  try {
    const stripe = getStripe();
    const account = await retrieveManagerConnectAccountOrNull(stripe, accountId);
    if (!account || !connectAccountTransfersActive(account)) {
      await finish({
        status: "failed",
        failureReason: "Vendor's Stripe payout account has not finished onboarding.",
      });
      return;
    }

    const transfer = await stripe.transfers.create(
      {
        amount: amountCents,
        currency: "usd",
        destination: accountId,
        metadata: { work_order_id: opts.workOrderId, manager_user_id: opts.managerUserId },
      },
      { idempotencyKey: `vendor-payout:${opts.workOrderId}` },
    );
    await finish({ status: "paid", stripeTransferId: transfer.id });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Stripe transfer failed.";
    await finish({ status: "failed", failureReason: message });
  }
}

const RETRYABLE_VENDOR_PAYOUT_FAILURE = /not connected|onboarding|Connect|payout account/i;

/** Re-attempt failed vendor payouts after Stripe Connect onboarding completes. */
export async function retryFailedVendorPayoutsForVendor(
  db: SupabaseClient,
  vendorUserId: string,
): Promise<void> {
  const { data: failed } = await db
    .from("vendor_payouts")
    .select("id, work_order_id, manager_user_id, vendor_user_id, amount_cents, failure_reason")
    .eq("vendor_user_id", vendorUserId)
    .eq("status", "failed");

  for (const row of failed ?? []) {
    const reason = String(row.failure_reason ?? "");
    if (!RETRYABLE_VENDOR_PAYOUT_FAILURE.test(reason)) continue;
    const workOrderId = String(row.work_order_id ?? "").trim();
    const managerUserId = String(row.manager_user_id ?? "").trim();
    if (!workOrderId || !managerUserId) continue;

    await db.from("vendor_payouts").delete().eq("id", row.id);
    await payoutVendorForWorkOrder(db, {
      workOrderId,
      managerUserId,
      vendorUserId,
      amountCents: Number(row.amount_cents) || 0,
    });
  }
}
