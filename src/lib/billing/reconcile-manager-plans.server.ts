import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { isAdminManagedManagerPurchase } from "@/lib/manager-admin-purchase";
import { reconcileManagerPurchaseWithApple } from "@/lib/manager-apple-subscription-sync";
import { reconcileManagerPurchaseWithStripe } from "@/lib/manager-stripe-subscription-sync";

/**
 * A daily sweep of the paid `manager_purchases` rows against the provider.
 *
 * The PropLane-managed view-only lock treats "self-paid" as the row's CURRENT tier, so the whole control depends on
 * a cancellation reaching that row. A webhook is the fast path (and now retries when the write fails), but a
 * webhook that Stripe eventually gives up on, or one that never arrived, used to leave a cancelled subscriber on
 * tier pro for ever - and an unlocked managed workspace with it. This is the slow path that closes that gap.
 *
 * Both reconcilers are conservative by design: they downgrade only when the provider DEFINITIVELY reports the
 * subscription gone (Stripe `resource_missing` / canceled, RevenueCat's authoritative subscriber read), and keep
 * the last known state on any transient error. Admin-granted rows are skipped - they have no provider to ask.
 *
 * Each run takes the least recently checked rows and stamps EVERY outcome, so the queue rotates. A row whose
 * provider could not answer is stamped with a retry-after as well: left unstamped it kept its place at the head of
 * the queue, and a provider having a bad day (or a batch of rows it always fails on) could fill the whole budget
 * with the same rows run after run while the tail - where an unreconciled cancellation hides - was never read.
 */

export type ManagerPlanReconcileResult = { checked: number; reconciled: number; failed: number; errors: string[] };

const PAID_TIERS = ["pro", "business"];
/** One run's work budget: each row costs one or two provider round trips under the route's 300 s. */
export const MANAGER_PLAN_RECONCILE_BATCH = 300;
/** How long a row that failed waits before the provider is asked again - longer than the daily cadence, so it is skipped exactly once. */
export const MANAGER_PLAN_RECONCILE_RETRY_HOURS = 25;

export async function reconcileManagerPlans(db: SupabaseClient, now: Date = new Date()): Promise<ManagerPlanReconcileResult> {
  const result: ManagerPlanReconcileResult = { checked: 0, reconciled: 0, failed: 0, errors: [] };
  type Row = { id?: string | null; user_id?: string | null; tier?: string | null; stripe_subscription_id?: string | null; apple_original_transaction_id?: string | null; stripe_checkout_session_id?: string | null; plan_reconcile_retry_at?: string | null };
  // Least recently checked first (never checked leads), so successive runs ADVANCE instead of re-reading the same
  // first page by user_id every day and never reaching the tail - where an unreconciled cancellation would hide.
  const { data, error } = await db
    .from("manager_purchases")
    .select("id, user_id, tier, stripe_subscription_id, apple_original_transaction_id, stripe_checkout_session_id, plan_reconcile_retry_at")
    .in("tier", PAID_TIERS)
    .order("plan_reconciled_at", { ascending: true, nullsFirst: true })
    .limit(MANAGER_PLAN_RECONCILE_BATCH);
  if (error) throw new Error(error.message || "Could not list manager plans.");

  for (const row of (data ?? []) as Row[]) {
    const userId = String(row.user_id ?? "").trim();
    const rowId = String(row.id ?? "").trim();
    // Backing off is also not asking again yet: a row re-read inside its retry window costs no provider call.
    const retryAt = Date.parse(String(row.plan_reconcile_retry_at ?? ""));
    if (Number.isFinite(retryAt) && retryAt > now.getTime()) continue;
    if (!userId || isAdminManagedManagerPurchase(row.stripe_checkout_session_id)) {
      await stamp(db, rowId, now);
      continue;
    }
    const stripeId = String(row.stripe_subscription_id ?? "").trim();
    const appleId = String(row.apple_original_transaction_id ?? "").trim();
    if (!stripeId && !appleId) {
      await stamp(db, rowId, now);
      continue;
    }
    result.checked += 1;
    try {
      if (stripeId) await reconcileManagerPurchaseWithStripe(userId);
      if (appleId) await reconcileManagerPurchaseWithApple(userId);
      result.reconciled += 1;
      await stamp(db, rowId, now);
    } catch (error) {
      result.failed += 1;
      if (result.errors.length < 20) result.errors.push(`${userId}: ${error instanceof Error ? error.message : "unknown"}`);
      await stamp(db, rowId, now, new Date(now.getTime() + MANAGER_PLAN_RECONCILE_RETRY_HOURS * 3_600_000));
    }
  }
  return result;
}

/**
 * Mark a row checked, and when the check failed, when it may be asked about again. A row that cannot be stamped is
 * simply re-checked next run; it never blocks the sweep.
 */
async function stamp(db: SupabaseClient, rowId: string, now: Date, retryAfter: Date | null = null): Promise<void> {
  if (!rowId) return;
  await db
    .from("manager_purchases")
    .update({ plan_reconciled_at: now.toISOString(), plan_reconcile_retry_at: retryAfter ? retryAfter.toISOString() : null })
    .eq("id", rowId)
    .then(undefined, () => undefined);
}
