import "server-only";

import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { retrieveManagerConnectAccountOrNull } from "@/lib/stripe-connect";
import { resolvePayoutsReadiness } from "@/lib/stripe-payouts-readiness.server";
import {
  claimWithdrawal,
  claimClassifiedWithdrawal,
  ensureBalanceAccountId,
  reverseWithdrawalClaim,
  stampWithdrawalTransfer,
} from "@/lib/proplane-balance/ledger.server";
import type { BalanceOwnerKind } from "@/lib/proplane-balance/types";
import { proplaneBalanceEnabled } from "@/lib/proplane-balance/flag";

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
  if (!account || account.id !== connectAccountId ||
      account.metadata?.axis_user_id !== opts.ownerUserId ||
      !resolvePayoutsReadiness(account).ready) {
    return { ok: false, status: 402, error: "Finish Stripe payout setup before withdrawing." };
  }

  const accountId = await ensureBalanceAccountId(db, opts.ownerKind, opts.ownerUserId);
  const classified = proplaneBalanceEnabled();
  const claim = classified
    ? await claimClassifiedWithdrawal(db, { accountId, ownerKind: opts.ownerKind,
      ownerUserId: opts.ownerUserId, amountCents: opts.amountCents,
      destinationAccountId: connectAccountId })
    : await claimWithdrawal(db, { accountId, amountCents: opts.amountCents });
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
        metadata: { proplane_balance_withdrawal: claim.idempotencyKey,
          proplane_balance_entry_id: claim.entryId,
          owner_kind: opts.ownerKind, owner_user_id: opts.ownerUserId },
      },
      { idempotencyKey: `balance-withdrawal-transfer:${claim.idempotencyKey}` },
    );
  } catch (e) {
    if (classified) {
      // Stripe can create a transfer and then lose its response. The debit
      // and source reservation stay in force until exact-key reconciliation.
      await db.from("proplane_balance_entries")
        .update({ withdrawal_provider_status: "unknown" })
        .eq("id", claim.entryId).is("stripe_object_id", null);
      return { ok: false, status: 409,
        error: "The withdrawal is being verified. Do not submit it again." };
    }
    const message = e instanceof Error ? e.message : "Stripe transfer failed.";
    await reverseWithdrawalClaim(db, { entryId: claim.entryId, accountId, amountCents: opts.amountCents }).catch(
      (reverseError) => console.error("[proplane-balance] could not reverse withdrawal claim", reverseError),
    );
    return { ok: false, status: 500, error: message };
  }

  if (classified) {
    const transferDestination = typeof transfer.destination === "string"
      ? transfer.destination : transfer.destination?.id;
    if (transfer.amount !== opts.amountCents || transfer.currency !== "usd" ||
        transferDestination !== connectAccountId ||
        transfer.metadata?.proplane_balance_withdrawal !== claim.idempotencyKey ||
        transfer.metadata?.proplane_balance_entry_id !== claim.entryId ||
        transfer.metadata?.owner_kind !== opts.ownerKind ||
        transfer.metadata?.owner_user_id !== opts.ownerUserId) {
      throw new Error("Withdrawal transfer does not match its frozen source claim.");
    }
    const { data: finished, error: finishError } = await db.rpc("finish_platform_classified_withdrawal", {
      p_entry: claim.entryId, p_key: claim.idempotencyKey,
      p_destination: connectAccountId, p_transfer: transfer.id,
    });
    if (finishError || finished?.stripe_object_id !== transfer.id) {
      throw new Error(finishError?.message ?? "Withdrawal transfer could not be recorded.");
    }
  } else {
    await stampWithdrawalTransfer(db, { entryId: claim.entryId, transferId: transfer.id });
  }

  try {
    const payout = await stripe.payouts.create(
      { amount: opts.amountCents, currency: "usd", method: "standard", metadata: {
        proplane_balance_withdrawal: claim.idempotencyKey,
        proplane_balance_entry_id: claim.entryId,
        proplane_balance_transfer_id: transfer.id } },
      { stripeAccount: connectAccountId, idempotencyKey: `balance-withdrawal-payout:${claim.idempotencyKey}` },
    );
    if (classified) {
      if (payout.amount !== opts.amountCents || payout.currency !== "usd" ||
          payout.method !== "standard" ||
          payout.metadata?.proplane_balance_withdrawal !== claim.idempotencyKey ||
          payout.metadata?.proplane_balance_entry_id !== claim.entryId ||
          payout.metadata?.proplane_balance_transfer_id !== transfer.id) {
        throw new Error("Withdrawal payout does not match its frozen source claim.");
      }
      const { data: stamped, error: stampError } = await db.from("proplane_balance_entries")
        .update({ withdrawal_payout_id: payout.id, withdrawal_provider_status: "payout_created" })
        .eq("id", claim.entryId).eq("stripe_object_id", transfer.id)
        .eq("withdrawal_destination_account_id", connectAccountId)
        .select("id").maybeSingle();
      if (stampError || stamped?.id !== claim.entryId) {
        throw new Error("Withdrawal payout could not be recorded.");
      }
    }
    return { ok: true, transferId: transfer.id, payoutId: payout.id, payoutPending: false };
  } catch (e) {
    const message = e instanceof Error ? e.message : "The transfer completed but the automatic payout failed.";
    // Money already left the platform balance for the recipient's own Connect
    // account — real, withdrawable money there. Never reverse the ledger here.
    return { ok: true, transferId: transfer.id, payoutId: null, payoutPending: true, payoutError: message };
  }
}
