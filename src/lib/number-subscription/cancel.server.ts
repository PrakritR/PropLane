import "server-only";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getStripe } from "@/lib/stripe";
import type { NumberOwnerRole } from "./constants";

/**
 * Stop a PropLane Number subscription before the account's rows are removed. Deleting an account
 * purges `number_subscriptions` (the Stripe ids with it), so cancelling afterwards would have nothing
 * left to look up and the customer would keep being billed for an account that no longer exists -
 * the same reason `cancelActiveManagerSubscription` runs first.
 *
 * - `role` limits the cancel to a subscription owned in that role (deleting only the vendor portal
 *   must not stop a resident subscription, and the other way round); omit it for a whole-account delete.
 * - A subscription already gone at Stripe, or already canceled, is a completed cancellation.
 * - Any other Stripe failure THROWS so the delete aborts and can be retried; it is never swallowed.
 * - Idempotent: a retry after a partial failure finds the subscription canceled and returns.
 */
export async function cancelNumberSubscriptionForAccount(
  db: SupabaseClient,
  userId: string,
  opts: { role?: NumberOwnerRole; stripe?: Pick<Stripe, "subscriptions"> } = {},
): Promise<"none" | "canceled"> {
  const { data, error: readError } = await db
    .from("number_subscriptions")
    .select("owner_role, stripe_subscription_id")
    .eq("owner_user_id", userId)
    .maybeSingle();
  if (readError) {
    // An environment that has not applied the number_subscriptions migration has nothing to cancel;
    // any other read failure aborts the delete (retryable) rather than risk leaving billing running.
    if (readError.code === "42P01" || readError.code === "PGRST205") return "none";
    throw new Error("Number subscription could not be checked before deletion.");
  }
  const subscription = data as { owner_role?: NumberOwnerRole; stripe_subscription_id?: string | null } | null;
  if (!subscription) return "none";
  if (opts.role && subscription.owner_role !== opts.role) return "none";
  const subscriptionId = subscription.stripe_subscription_id?.trim();
  if (!subscriptionId) return "none";
  const stripe = opts.stripe ?? getStripe();
  try {
    await stripe.subscriptions.cancel(subscriptionId);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
    if (code === "resource_missing") return "canceled";
    // Stripe refuses to cancel a subscription that is already canceled: confirm that, else surface the failure.
    const live = await stripe.subscriptions.retrieve(subscriptionId).catch(() => null);
    if (live?.status !== "canceled") throw error;
  }
  return "canceled";
}
