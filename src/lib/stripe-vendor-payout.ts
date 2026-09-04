import type { SupabaseClient } from "@supabase/supabase-js";
import { getStripe } from "@/lib/stripe";
import { retrieveManagerConnectAccountOrNull, connectAccountTransfersActive } from "@/lib/stripe-connect";

/**
 * Best-effort Stripe Connect transfer of a vendor's share to their connected account when a
 * work order is approved + paid. Never throws — a Stripe failure (no account, not onboarded,
 * not configured, insufficient platform balance, etc.) is recorded as a "failed" vendor_payouts
 * row so the manager's approve-pay bookkeeping flow always succeeds regardless of payout outcome.
 *
 * Concurrency-safe: claims the payout row (status "pending") before ever calling Stripe, so the
 * unique index on vendor_payouts.work_order_id is the sole arbiter of "who gets to transfer" —
 * two concurrent/retried calls for the same work order race the claim, and only the winner
 * proceeds to Stripe. Also passes a deterministic idempotencyKey so even a Stripe-level retry of
 * the winner's own request can't double-transfer.
 *
 * A payout that already exists as "pending" or "paid" ends the call with no Stripe request. A
 * "failed" one is RE-CLAIMED, because the commonest failure is a vendor who had not finished
 * Stripe Connect onboarding at approval time and finishes it a day later. That unique index plus
 * a claim that returned early on any existing row made a failed payout permanent: money owed with
 * nothing in the product that would ever try again. The status predicate on the re-claim keeps it
 * a compare-and-swap, so concurrent re-drives still produce exactly one transfer.
 *
 * The amount is anchored to the work order's accepted bid whenever the job was bid at all (a
 * vendor/manager agreed amount, immune to a forged request body). It falls back to the
 * caller-supplied amount ONLY for jobs assigned without formal bidding — a job that HAS bids but
 * no accepted one is a missing anchor, and pays nothing rather than an unverified number.
 */
/**
 * What actually happened, so the caller can tell somebody.
 *
 * The manager marks a job paid and their bookkeeping succeeds either way; without
 * this they had no way to learn the transfer did not happen, and the vendor was
 * owed money with nothing on screen saying so.
 *
 * `skipped` means no transfer was attempted and none is owed through this path
 * (nothing to pay, or another call already owns this payout).
 */
export type VendorPayoutOutcome = {
  status: "paid" | "failed" | "skipped";
  amountCents: number;
  failureReason?: string;
};

export async function payoutVendorForWorkOrder(
  db: SupabaseClient,
  opts: { workOrderId: string; managerUserId: string; vendorUserId: string; amountCents: number },
): Promise<VendorPayoutOutcome> {
  const { data: bids } = await db
    .from("work_order_bids")
    .select("amount_cents, status")
    .eq("work_order_id", opts.workOrderId);
  const bidRows = (bids ?? []) as Array<{ amount_cents: number | null; status: string | null }>;
  const acceptedBid = bidRows.find((bid) => bid.status === "accepted");
  // A job with bids but none accepted has LOST its anchor — a bid re-priced by a
  // race used to land here, and falling through to `opts.amountCents` turned that
  // race into a payment of the one number the anchor exists to stop us trusting.
  if (!acceptedBid && bidRows.length > 0) return { status: "skipped", amountCents: 0 };
  const amountCents = (acceptedBid?.amount_cents as number | null) ?? opts.amountCents;
  if (!amountCents || amountCents <= 0) return { status: "skipped", amountCents: 0 };

  const nowIso = new Date().toISOString();
  const { data: claimed } = await db
    .from("vendor_payouts")
    .insert({
      manager_user_id: opts.managerUserId,
      vendor_user_id: opts.vendorUserId,
      work_order_id: opts.workOrderId,
      amount_cents: amountCents,
      status: "pending",
    })
    .select("id")
    .maybeSingle();
  // The insert lost to the unique index, so a payout row already exists. Only a
  // failed one may be retried, and only by whoever wins the status swap.
  const { data: reclaimed } = claimed
    ? { data: null }
    : await db
        .from("vendor_payouts")
        .update({ status: "pending", amount_cents: amountCents, failure_reason: null, updated_at: nowIso })
        .eq("work_order_id", opts.workOrderId)
        .eq("status", "failed")
        .select("id")
        .maybeSingle();
  const payoutId = ((claimed ?? reclaimed) as { id?: string } | null)?.id;
  if (!payoutId) return { status: "skipped", amountCents };

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
    const failureReason = "Vendor has not connected a Stripe payout account yet.";
    await finish({ status: "failed", failureReason });
    return { status: "failed", amountCents, failureReason };
  }

  try {
    const stripe = getStripe();
    const account = await retrieveManagerConnectAccountOrNull(stripe, accountId);
    if (!account || !connectAccountTransfersActive(account)) {
      const failureReason = "Vendor's Stripe payout account has not finished onboarding.";
      await finish({ status: "failed", failureReason });
      return { status: "failed", amountCents, failureReason };
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
    return { status: "paid", amountCents };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Stripe transfer failed.";
    await finish({ status: "failed", failureReason: message });
    return { status: "failed", amountCents, failureReason: message };
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
