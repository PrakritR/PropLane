import "server-only";

import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { connectAccountReadyForAchPayouts, retrieveManagerConnectAccountOrNull } from "@/lib/stripe-connect";
import {
  claimWithdrawal,
  ensureBalanceAccountId,
  reverseWithdrawalClaim,
  stampWithdrawalTransfer,
} from "@/lib/proplane-balance/ledger.server";
import type { BalanceOwnerKind } from "@/lib/proplane-balance/types";

export type WithdrawFromBalanceResult =
  | { ok: true; transferId: string; payoutId: string; payoutPending: false }
  | { ok: true; transferId: string; payoutId: null; payoutPending: true; payoutError: string }
  | { ok: false; status: 400 | 402 | 403 | 409 | 422 | 500; error: string };

/**
 * Withdraw from the PropLane balance ledger for a manager (workspace) or
 * vendor: claim-before-call (`claimWithdrawal`), then a real
 * `transfers.create` platform → the owner's OWN Connect account (the same
 * KYC'd account `stripe-payouts.server.ts` already pays out to), then
 * `payouts.create` on that account to send it to their bank — the exact
 * "Transfer + Payout" shape `research.md`'s "Recommended money architecture"
 * calls for.
 *
 * If the transfer call itself fails, no real money left the platform balance,
 * so the ledger claim is reversed. If only the follow-up payout fails, the
 * money is already real, withdrawable money in the recipient's Connect
 * account balance — the ledger is NOT reversed, and the caller is told to
 * retry from the existing Payouts UI (`/portal/payments/payouts` /
 * `/vendor/financials/payouts`), which already has its own claim-before-call
 * retry path (`createInAppPayout`).
 */
export async function withdrawFromBalance(
  stripe: Stripe,
  db: SupabaseClient,
  opts: { ownerKind: BalanceOwnerKind; ownerUserId: string; amountCents: number },
): Promise<WithdrawFromBalanceResult> {
  if (!Number.isFinite(opts.amountCents) || opts.amountCents <= 0) {
    return { ok: false, status: 400, error: "Amount must be a positive number of cents." };
  }

  const { data: profile } = await db
    .from("profiles")
    .select("stripe_connect_account_id")
    .eq("id", opts.ownerUserId)
    .maybeSingle();
  const connectAccountId = (profile as { stripe_connect_account_id?: string | null } | null)
    ?.stripe_connect_account_id?.trim();
  if (!connectAccountId) {
    return { ok: false, status: 402, error: "Finish Stripe payout setup before withdrawing." };
  }
  const account = await retrieveManagerConnectAccountOrNull(stripe, connectAccountId);
  if (!account || !connectAccountReadyForAchPayouts(account)) {
    return { ok: false, status: 402, error: "Finish Stripe payout setup before withdrawing." };
  }

  const accountId = await ensureBalanceAccountId(db, opts.ownerKind, opts.ownerUserId);
  const claim = await claimWithdrawal(db, { accountId, amountCents: opts.amountCents });
  if (!claim.ok) {
    if (claim.code === "conflict") return { ok: false, status: 409, error: claim.error };
    if (claim.code === "insufficient_balance") {
      return {
        ok: false,
        status: 422,
        error: `Only ${(claim.availableCents / 100).toFixed(2)} is available to withdraw.`,
      };
    }
    return { ok: false, status: 500, error: claim.error };
  }

  let transfer: Stripe.Transfer;
  try {
    transfer = await stripe.transfers.create(
      {
        amount: opts.amountCents,
        currency: "usd",
        destination: connectAccountId,
        metadata: { proplane_balance_withdrawal: claim.idempotencyKey, owner_kind: opts.ownerKind, owner_user_id: opts.ownerUserId },
      },
      { idempotencyKey: `balance-withdrawal-transfer:${claim.idempotencyKey}` },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : "Stripe transfer failed.";
    await reverseWithdrawalClaim(db, { entryId: claim.entryId, accountId, amountCents: opts.amountCents }).catch(
      (reverseError) => console.error("[proplane-balance] could not reverse withdrawal claim", reverseError),
    );
    return { ok: false, status: 500, error: message };
  }

  await stampWithdrawalTransfer(db, { entryId: claim.entryId, transferId: transfer.id });

  try {
    const payout = await stripe.payouts.create(
      { amount: opts.amountCents, currency: "usd", method: "standard" },
      { stripeAccount: connectAccountId, idempotencyKey: `balance-withdrawal-payout:${claim.idempotencyKey}` },
    );
    return { ok: true, transferId: transfer.id, payoutId: payout.id, payoutPending: false };
  } catch (e) {
    const message = e instanceof Error ? e.message : "The transfer completed but the automatic payout failed.";
    // Money already left the platform balance for the recipient's own Connect
    // account — real, withdrawable money there. Never reverse the ledger here.
    return { ok: true, transferId: transfer.id, payoutId: null, payoutPending: true, payoutError: message };
  }
}
