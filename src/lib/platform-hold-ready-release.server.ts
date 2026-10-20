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
/** Rows read per page while collecting distinct owners, and how many pages one run will walk. */
const ROW_PAGE = 1_000;
const MAX_ROW_PAGES = 20;

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
  // DISTINCT OWNERS, paged on `created_at`. A flat window of the oldest rows starved every other owner once one of
  // them - a frozen unsigned service workspace, an owner with no payouts-ready account - held more rows than the
  // window: their holds never release, sit permanently at the head, and nobody behind them is ever read.
  const owners: string[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  let more = true;
  for (let page = 0; page < MAX_ROW_PAGES && more && owners.length < OWNER_PAGE + 1; page += 1) {
    let query = db
      .from("platform_payment_holds")
      .select("owner_user_id, created_at")
      .eq("status", "classified_held")
      .not("source_verified_at", "is", null)
      .not("owner_user_id", "is", null)
      .order("created_at", { ascending: true })
      .limit(ROW_PAGE);
    if (cursor) query = query.gt("created_at", cursor);
    const { data, error } = await query;
    if (error) throw new Error("Could not load held platform money.");
    const rows = (data ?? []) as Array<{ owner_user_id: string | null; created_at: string | null }>;
    for (const row of rows) {
      const id = String(row.owner_user_id ?? "").trim();
      if (id && !seen.has(id)) {
        seen.add(id);
        owners.push(id);
      }
    }
    const last = rows[rows.length - 1]?.created_at ?? null;
    // No page advance possible (every row shares one `created_at`): stop rather than re-read the same page.
    more = rows.length === ROW_PAGE && Boolean(last) && last !== cursor;
    cursor = last ?? cursor;
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
