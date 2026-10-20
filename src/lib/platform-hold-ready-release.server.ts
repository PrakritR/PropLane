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

type HoldRow = { id?: string | null; owner_user_id: string | null; created_at: string | null };
type HoldCursor = { createdAt: string; id: string };

const HOLD_PAGE_COLUMNS = "id, owner_user_id, created_at";

/**
 * One page of verified held rows, strictly after `cursor` in (created_at, id) order.
 *
 * PostgREST has no tuple comparison, so the pair is two reads: the rest of the boundary timestamp by id, then - if
 * that did not fill the page - the timestamps beyond it. Nothing can be stepped over, and progress is guaranteed
 * even when one timestamp holds more rows than a whole page, which is what a batch insert or a backfill produces.
 */
async function readHoldOwnerPage(db: SupabaseClient, cursor: HoldCursor | null): Promise<HoldRow[]> {
  const base = () =>
    db
      .from("platform_payment_holds")
      .select(HOLD_PAGE_COLUMNS)
      .eq("status", "classified_held")
      .not("source_verified_at", "is", null)
      .not("owner_user_id", "is", null);
  const read = async (query: PromiseLike<{ data: unknown; error: unknown }>): Promise<HoldRow[]> => {
    const { data, error } = await query;
    if (error) throw new Error("Could not load held platform money.");
    return (data ?? []) as HoldRow[];
  };

  const sameStamp = cursor
    ? await read(base().eq("created_at", cursor.createdAt).gt("id", cursor.id).order("id", { ascending: true }).limit(ROW_PAGE))
    : [];
  if (sameStamp.length >= ROW_PAGE) return sameStamp;

  const laterQuery = base().order("created_at", { ascending: true }).order("id", { ascending: true }).limit(ROW_PAGE - sameStamp.length);
  const later = await read(cursor ? laterQuery.gt("created_at", cursor.createdAt) : laterQuery);
  return [...sameStamp, ...later];
}

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
  // DISTINCT OWNERS, paged as a keyset on (created_at, id). A flat window of the oldest rows starved every other
  // owner once one of them - a frozen unsigned service workspace, an owner with no payouts-ready account - held
  // more rows than the window: their holds never release, sit permanently at the head, and nobody behind them is
  // ever read. `created_at` alone is not a key either: advancing past it with `gt` steps over every other row
  // sharing the boundary timestamp (rows written by one batch or backfill share one), so an owner whose only
  // holds sit on that boundary is skipped on every run - and re-entering the page with `gte` cannot advance at all
  // once one timestamp fills it. Hence the pair, read as `readHoldOwnerPage` builds it.
  const owners: string[] = [];
  const seen = new Set<string>();
  let cursor: HoldCursor | null = null;
  for (let page = 0; page < MAX_ROW_PAGES && owners.length < OWNER_PAGE + 1; page += 1) {
    const rows = await readHoldOwnerPage(db, cursor);
    if (rows.length === 0) break;
    for (const row of rows) {
      const id = String(row.owner_user_id ?? "").trim();
      if (id && !seen.has(id)) {
        seen.add(id);
        owners.push(id);
      }
    }
    const last = rows[rows.length - 1]!;
    cursor = { createdAt: String(last.created_at ?? ""), id: String(last.id ?? "") };
    if (rows.length < ROW_PAGE || !cursor.createdAt || !cursor.id) break;
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
