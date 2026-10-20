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
 * Each run takes the least recently checked rows and stamps what it finished, so the queue rotates and a provider
 * failure leaves its row at the front rather than at the back.
 */

export type ManagerPlanReconcileResult = { checked: number; reconciled: number; failed: number; errors: string[] };

const PAID_TIERS = ["pro", "business"];
/** One run's work budget: each row costs one or two provider round trips under the route's 300 s. */
export const MANAGER_PLAN_RECONCILE_BATCH = 300;

export async function reconcileManagerPlans(db: SupabaseClient, now: Date = new Date()): Promise<ManagerPlanReconcileResult> {
  const result: ManagerPlanReconcileResult = { checked: 0, reconciled: 0, failed: 0, errors: [] };
  type Row = { id?: string | null; user_id?: string | null; tier?: string | null; stripe_subscription_id?: string | null; apple_original_transaction_id?: string | null; stripe_checkout_session_id?: string | null };
  // Least recently checked first (never checked leads), so successive runs ADVANCE instead of re-reading the same
  // first page by user_id every day and never reaching the tail - where an unreconciled cancellation would hide.
  const { data, error } = await db
    .from("manager_purchases")
    .select("id, user_id, tier, stripe_subscription_id, apple_original_transaction_id, stripe_checkout_session_id")
    .in("tier", PAID_TIERS)
    .order("plan_reconciled_at", { ascending: true, nullsFirst: true })
    .limit(MANAGER_PLAN_RECONCILE_BATCH);
  if (error) throw new Error(error.message || "Could not list manager plans.");

  for (const row of (data ?? []) as Row[]) {
    const userId = String(row.user_id ?? "").trim();
    const rowId = String(row.id ?? "").trim();
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
      // Not stamped: a row whose provider could not answer stays at the front of the queue for the next run.
    }
  }
  return result;
}

/** Mark a row checked. A row that cannot be stamped is simply re-checked next run; it never blocks the sweep. */
async function stamp(db: SupabaseClient, rowId: string, now: Date): Promise<void> {
  if (!rowId) return;
  await db
    .from("manager_purchases")
    .update({ plan_reconciled_at: now.toISOString() })
    .eq("id", rowId)
    .then(undefined, () => undefined);
}
