import "server-only";

import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { proplaneBalanceEnabled } from "@/lib/proplane-balance/flag";

type Claim = {
  id: string; account_id: string; amount_cents: number; idempotency_key: string;
  stripe_object_id: string | null; withdrawal_destination_account_id: string;
  withdrawal_payout_id: string | null; created_at: string;
};

const SAME_KEY_RETRY_MS = 20 * 60 * 60 * 1000;
const MAX_PROVIDER_ROWS = 1000;

function transferMatches(transfer: Stripe.Transfer, claim: Claim, ownerKind: string, ownerUserId: string): boolean {
  const destination = typeof transfer.destination === "string"
    ? transfer.destination : transfer.destination?.id;
  return transfer.amount === -claim.amount_cents && transfer.currency === "usd" &&
    destination === claim.withdrawal_destination_account_id &&
    transfer.metadata?.proplane_balance_withdrawal === claim.idempotency_key &&
    transfer.metadata?.proplane_balance_entry_id === claim.id &&
    transfer.metadata?.owner_kind === ownerKind &&
    transfer.metadata?.owner_user_id === ownerUserId &&
    (transfer.amount_reversed ?? 0) === 0;
}

function payoutMatches(payout: Stripe.Payout, claim: Claim, transferId: string): boolean {
  return payout.amount === -claim.amount_cents && payout.currency === "usd" &&
    payout.method === "standard" &&
    payout.metadata?.proplane_balance_withdrawal === claim.idempotency_key &&
    payout.metadata?.proplane_balance_entry_id === claim.id &&
    payout.metadata?.proplane_balance_transfer_id === transferId;
}

async function exactTransferFromProvider(stripe: Stripe, claim: Claim,
  ownerKind: string, ownerUserId: string): Promise<Stripe.Transfer | null> {
  const since = Math.floor(Date.parse(claim.created_at) / 1000) - 60;
  if (!Number.isSafeInteger(since)) throw new Error("Withdrawal claim has no valid origin date.");
  let startingAfter: string | undefined;
  let scanned = 0;
  const matches: Stripe.Transfer[] = [];
  for (;;) {
    const page = await stripe.transfers.list({ destination: claim.withdrawal_destination_account_id,
      created: { gte: since }, limit: 100, starting_after: startingAfter });
    scanned += page.data.length;
    for (const transfer of page.data) {
      if (transfer.metadata?.proplane_balance_withdrawal !== claim.idempotency_key) continue;
      if (!transferMatches(transfer, claim, ownerKind, ownerUserId)) {
        throw new Error("Withdrawal provider transfer differs from its frozen claim.");
      }
      matches.push(transfer);
    }
    if (scanned > MAX_PROVIDER_ROWS || (page.has_more &&
        (scanned >= MAX_PROVIDER_ROWS || page.data.length === 0))) {
      throw new Error("Withdrawal transfer search is incomplete; keep the claim reserved.");
    }
    if (!page.has_more) break;
    startingAfter = page.data.at(-1)?.id;
    if (!startingAfter) throw new Error("Withdrawal transfer search cannot advance.");
  }
  if (matches.length > 1) throw new Error("Withdrawal has multiple exact provider transfers.");
  return matches[0] ?? null;
}

async function exactPayoutFromProvider(stripe: Stripe, claim: Claim,
  transferId: string): Promise<Stripe.Payout | null> {
  const since = Math.floor(Date.parse(claim.created_at) / 1000) - 60;
  if (!Number.isSafeInteger(since)) throw new Error("Withdrawal claim has no valid origin date.");
  let startingAfter: string | undefined;
  let scanned = 0;
  const matches: Stripe.Payout[] = [];
  for (;;) {
    const page = await stripe.payouts.list({ created: { gte: since }, limit: 100,
      starting_after: startingAfter }, { stripeAccount: claim.withdrawal_destination_account_id });
    scanned += page.data.length;
    for (const payout of page.data) {
      if (payout.metadata?.proplane_balance_withdrawal !== claim.idempotency_key) continue;
      if (!payoutMatches(payout, claim, transferId)) {
        throw new Error("Withdrawal provider payout differs from its frozen claim.");
      }
      matches.push(payout);
    }
    if (scanned > MAX_PROVIDER_ROWS || (page.has_more &&
        (scanned >= MAX_PROVIDER_ROWS || page.data.length === 0))) {
      throw new Error("Withdrawal payout search is incomplete; keep the claim reserved.");
    }
    if (!page.has_more) break;
    startingAfter = page.data.at(-1)?.id;
    if (!startingAfter) throw new Error("Withdrawal payout search cannot advance.");
  }
  if (matches.length > 1) throw new Error("Withdrawal has multiple exact provider payouts.");
  return matches[0] ?? null;
}

/** Exact retained-key reconciliation. Provider absence alone never releases a
 * claim; after the idempotency window it stays reserved for review. */
export async function reconcileClassifiedBalanceWithdrawals(
  stripe: Stripe, db: SupabaseClient, opts: { limit?: number } = {},
): Promise<{ scanned: number; transfers: number; payouts: number; pending: number; errors: string[] }> {
  const result = { scanned: 0, transfers: 0, payouts: 0, pending: 0, errors: [] as string[] };
  if (!proplaneBalanceEnabled()) return result;
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50), 1), 100);
  const { data, error } = await db.from("proplane_balance_entries")
    .select("id,account_id,amount_cents,idempotency_key,stripe_object_id,withdrawal_destination_account_id,withdrawal_payout_id,created_at")
    .eq("kind", "withdrawal").not("withdrawal_destination_account_id", "is", null)
    .is("withdrawal_payout_id", null).order("created_at", { ascending: true }).limit(limit);
  if (error) throw new Error(`Could not scan classified withdrawals: ${error.message}`);
  for (const claim of (data ?? []) as Claim[]) {
    result.scanned += 1;
    try {
      if (!claim.id || !claim.idempotency_key || !claim.withdrawal_destination_account_id ||
          !Number.isSafeInteger(claim.amount_cents) || claim.amount_cents >= 0) {
        throw new Error("Withdrawal claim has invalid frozen terms.");
      }
      const { data: account, error: accountError } = await db.from("proplane_balance_accounts")
        .select("owner_kind,owner_key,currency").eq("id", claim.account_id).maybeSingle();
      if (accountError || !account || !["workspace", "vendor"].includes(account.owner_kind) ||
          account.currency !== "usd" || !account.owner_key) {
        throw new Error("Withdrawal account ownership needs review.");
      }
      const ownerKind = account.owner_kind as "workspace" | "vendor";
      const ownerUserId = account.owner_key;
      const destination = await stripe.accounts.retrieve(claim.withdrawal_destination_account_id);
      if (destination.id !== claim.withdrawal_destination_account_id ||
          destination.metadata?.axis_user_id !== ownerUserId) {
        throw new Error("Frozen withdrawal destination no longer belongs to this owner.");
      }
      let transferId = claim.stripe_object_id;
      if (!transferId) {
        const observed = await exactTransferFromProvider(stripe, claim, ownerKind, ownerUserId);
        let transfer = observed;
        if (!transfer && Date.now() - Date.parse(claim.created_at) < SAME_KEY_RETRY_MS) {
          transfer = await stripe.transfers.create({ amount: -claim.amount_cents,
            currency: "usd", destination: claim.withdrawal_destination_account_id,
            metadata: { proplane_balance_withdrawal: claim.idempotency_key,
              proplane_balance_entry_id: claim.id,
              owner_kind: ownerKind, owner_user_id: ownerUserId } },
          { idempotencyKey: `balance-withdrawal-transfer:${claim.idempotency_key}` });
        }
        if (!transfer) { result.pending += 1; continue; }
        if (!transferMatches(transfer, claim, ownerKind, ownerUserId)) {
          throw new Error("Withdrawal provider transfer differs from its frozen claim.");
        }
        const { data: finished, error: finishError } = await db.rpc("finish_platform_classified_withdrawal", {
          p_entry: claim.id, p_key: claim.idempotency_key,
          p_destination: claim.withdrawal_destination_account_id, p_transfer: transfer.id,
        });
        if (finishError || finished?.stripe_object_id !== transfer.id) {
          throw new Error("Withdrawal transfer settlement needs review.");
        }
        transferId = transfer.id;
        result.transfers += 1;
      } else {
        if (!transferId.startsWith("tr_")) throw new Error("Withdrawal has no real transfer id.");
        const transfer = await stripe.transfers.retrieve(transferId);
        if (!transferMatches(transfer, claim, ownerKind, ownerUserId)) {
          throw new Error("Recorded withdrawal transfer differs from provider.");
        }
      }
      const observedPayout = await exactPayoutFromProvider(stripe, claim, transferId);
      let payout = observedPayout;
      if (!payout && Date.now() - Date.parse(claim.created_at) < SAME_KEY_RETRY_MS) {
        payout = await stripe.payouts.create({ amount: -claim.amount_cents,
          currency: "usd", method: "standard", metadata: {
            proplane_balance_withdrawal: claim.idempotency_key,
            proplane_balance_entry_id: claim.id,
            proplane_balance_transfer_id: transferId } },
        { stripeAccount: claim.withdrawal_destination_account_id,
          idempotencyKey: `balance-withdrawal-payout:${claim.idempotency_key}` });
      }
      if (!payout) { result.pending += 1; continue; }
      if (!payoutMatches(payout, claim, transferId)) {
        throw new Error("Withdrawal provider payout differs from its frozen claim.");
      }
      const { data: stamped, error: stampError } = await db.from("proplane_balance_entries")
        .update({ withdrawal_payout_id: payout.id, withdrawal_provider_status: "payout_created" })
        .eq("id", claim.id).eq("stripe_object_id", transferId)
        .eq("withdrawal_destination_account_id", claim.withdrawal_destination_account_id)
        .select("id").maybeSingle();
      if (stampError || stamped?.id !== claim.id) {
        throw new Error("Withdrawal payout adoption needs review.");
      }
      result.payouts += 1;
    } catch (reason) {
      result.errors.push(`${claim.id}: ${reason instanceof Error ? reason.message : String(reason)}`);
    }
  }
  return result;
}
