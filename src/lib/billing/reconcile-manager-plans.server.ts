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
 */

export type ManagerPlanReconcileResult = { checked: number; reconciled: number; failed: number; errors: string[] };

const PAID_TIERS = ["pro", "business"];
const PAGE_SIZE = 500;
const MAX_PAGES = 20;

export async function reconcileManagerPlans(db: SupabaseClient): Promise<ManagerPlanReconcileResult> {
  const result: ManagerPlanReconcileResult = { checked: 0, reconciled: 0, failed: 0, errors: [] };
  type Row = { user_id?: string | null; tier?: string | null; stripe_subscription_id?: string | null; apple_original_transaction_id?: string | null; stripe_checkout_session_id?: string | null };
  const rows: Row[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const from = page * PAGE_SIZE;
    const { data, error } = await db
      .from("manager_purchases")
      .select("user_id, tier, stripe_subscription_id, apple_original_transaction_id, stripe_checkout_session_id")
      .in("tier", PAID_TIERS)
      .order("user_id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message || "Could not list manager plans.");
    const batch = (data ?? []) as Row[];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }

  for (const row of rows) {
    const userId = String(row.user_id ?? "").trim();
    if (!userId || isAdminManagedManagerPurchase(row.stripe_checkout_session_id)) continue;
    const stripeId = String(row.stripe_subscription_id ?? "").trim();
    const appleId = String(row.apple_original_transaction_id ?? "").trim();
    if (!stripeId && !appleId) continue;
    result.checked += 1;
    try {
      if (stripeId) await reconcileManagerPurchaseWithStripe(userId);
      if (appleId) await reconcileManagerPurchaseWithApple(userId);
      result.reconciled += 1;
    } catch (error) {
      result.failed += 1;
      if (result.errors.length < 20) result.errors.push(`${userId}: ${error instanceof Error ? error.message : "unknown"}`);
    }
  }
  return result;
}
