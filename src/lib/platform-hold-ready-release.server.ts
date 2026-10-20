import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import { connectAccountReadyForAchPayouts } from "@/lib/stripe-connect";
import { handleStripeAccountUpdated } from "@/lib/stripe-webhook-financials";

export type ReleaseReadyHoldsDeps = {
  /** Applies a freshly read account exactly as the `account.updated` webhook does (flags, payouts-ready text, hold release). */
  applyAccount?: (db: SupabaseClient, account: Stripe.Account) => Promise<void>;
};

export type ReleaseReadyHoldsResult = {
  owners: number;
  ready: number;
  notReady: number;
  errors: string[];
  truncated: boolean;
};

const OWNER_PAGE = 200;

/**
 * Backstop for a lost or never-delivered `account.updated` webhook (the Connect endpoint's secret was missing, or the endpoint
 * was down): for every owner who has verified held money and a saved Connect account, read the account at Stripe, and when it can
 * receive payouts apply it exactly like the webhook would. That records the readiness flags, texts "payouts ready" once on the
 * transition, and releases the owner's held money through `releaseVerifiedPlatformHoldsForOwner`, whose source-backed
 * reservation and idempotency key make a repeat run (or a racing webhook) a no-op. A frozen unsigned service workspace stays held.
 */
export async function releaseReadyPlatformHolds(
  db: SupabaseClient,
  stripe: Pick<Stripe, "accounts">,
  deps: ReleaseReadyHoldsDeps = {},
): Promise<ReleaseReadyHoldsResult> {
  const apply = deps.applyAccount ?? handleStripeAccountUpdated;
  const { data, error } = await db
    .from("platform_payment_holds")
    .select("owner_user_id, created_at")
    .eq("status", "classified_held")
    .not("source_verified_at", "is", null)
    .not("owner_user_id", "is", null)
    .order("created_at", { ascending: true })
    .limit(OWNER_PAGE * 5);
  if (error) throw new Error("Could not load held platform money.");
  const owners: string[] = [];
  for (const row of (data ?? []) as Array<{ owner_user_id: string | null }>) {
    const id = String(row.owner_user_id ?? "").trim();
    if (id && !owners.includes(id)) owners.push(id);
  }
  const result: ReleaseReadyHoldsResult = { owners: 0, ready: 0, notReady: 0, errors: [], truncated: owners.length > OWNER_PAGE };
  const batch = owners.slice(0, OWNER_PAGE);
  result.owners = batch.length;
  if (batch.length === 0) return result;

  const { data: profiles, error: profileError } = await db
    .from("profiles").select("id, stripe_connect_account_id").in("id", batch);
  if (profileError) throw new Error("Could not load payout accounts for held money.");
  const accountByOwner = new Map<string, string>();
  for (const p of (profiles ?? []) as Array<{ id: string; stripe_connect_account_id?: string | null }>) {
    const acct = String(p.stripe_connect_account_id ?? "").trim();
    if (acct) accountByOwner.set(p.id, acct);
  }
  for (const ownerId of batch) {
    const accountId = accountByOwner.get(ownerId);
    if (!accountId) { result.notReady += 1; continue; }
    try {
      const account = await stripe.accounts.retrieve(accountId);
      if (account.id !== accountId || account.metadata?.axis_user_id !== ownerId) {
        result.errors.push(`${ownerId}: payout account does not match its owner`);
        continue;
      }
      if (!connectAccountReadyForAchPayouts(account)) { result.notReady += 1; continue; }
      await apply(db, account);
      result.ready += 1;
    } catch (e) {
      result.errors.push(`${ownerId}: ${e instanceof Error ? e.message : "failed"}`);
    }
  }
  return result;
}
