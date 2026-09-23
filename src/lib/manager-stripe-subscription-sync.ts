import type Stripe from "stripe";
import { resolveRateCardVersionMetadataPatch, syncManagerDoorQuantity } from "@/lib/billing/quantity-sync.server";
import { isAdminManagedManagerPurchase } from "@/lib/manager-admin-purchase";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripe";
import { stripeSubscriptionPeriodEndSec } from "@/lib/stripe-subscription-helpers";
import {
  inferBillingFromStripePriceId,
  inferPaidTierFromStripePriceId,
  stripePriceIdForPaidTier,
  type PaidTier,
  type StripeBilling,
} from "@/lib/stripe-price-ids";
import { META_SCHEDULED_BILLING, META_SCHEDULED_TIER } from "@/lib/stripe-subscription-metadata";
import { captureTestWorkspaceEffectForUser } from "@/lib/test-workspaces/effects.server";

function clearScheduleMetadata(meta: Record<string, string>): Record<string, string | null> {
  return {
    ...meta,
    [META_SCHEDULED_TIER]: null,
    [META_SCHEDULED_BILLING]: null,
  };
}

/**
 * After a renewal invoice, apply a deferred downgrade stored on the subscription
 * (`axis_scheduled_*` metadata) so the new period bills at the lower tier.
 */
export async function applyScheduledDowngradeAfterInvoicePaid(
  subscriptionId: string,
  billingReason: string | null | undefined,
): Promise<void> {
  if (billingReason !== "subscription_cycle") return;

  const supabase = createSupabaseServiceRoleClient();
  const { data: owner, error: ownerError } = await supabase
    .from("manager_purchases")
    .select("user_id")
    .eq("stripe_subscription_id", subscriptionId)
    .maybeSingle();
  if (ownerError) throw new Error("Could not resolve subscription ownership.");
  const ownerUserId = String((owner as { user_id?: string | null } | null)?.user_id ?? "").trim();
  if (!ownerUserId) throw new Error("Could not resolve subscription ownership.");
  if ((await captureTestWorkspaceEffectForUser({
    userId: ownerUserId,
    kind: "payment",
    summary: "Stripe subscription downgrade was refused for a test workspace.",
    metadata: { operation: "scheduled_subscription_downgrade" },
    db: supabase,
  })).captured) return;

  const stripe = getStripe();
  let sub: Stripe.Subscription;
  try {
    sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ["items.data.price"] });
  } catch {
    return;
  }

  const st = sub.metadata?.[META_SCHEDULED_TIER]?.trim().toLowerCase();
  const sb = sub.metadata?.[META_SCHEDULED_BILLING]?.trim().toLowerCase();
  if (st !== "pro" && st !== "business") return;
  if (sb !== "monthly" && sb !== "annual") return;

  const item = sub.items.data[0];
  if (!item?.id) return;

  const targetPaid = st as PaidTier;
  const targetBilling = sb as StripeBilling;
  const newPriceId = stripePriceIdForPaidTier(targetPaid, targetBilling)?.trim();
  if (!newPriceId) return;

  const currentPriceId = typeof item.price === "string" ? item.price : item.price?.id;
  if (currentPriceId === newPriceId) {
    const meta = {
      ...clearScheduleMetadata({ ...(sub.metadata ?? {}) }),
      ...(resolveRateCardVersionMetadataPatch(sub.metadata) ?? {}),
    };
    await stripe.subscriptions.update(subscriptionId, { metadata: meta });
    await reconcileManagerPurchaseByStripeSubscriptionId(subscriptionId);
    return;
  }

  const meta = {
    ...clearScheduleMetadata({ ...(sub.metadata ?? {}) }),
    ...(resolveRateCardVersionMetadataPatch(sub.metadata) ?? {}),
  };
  await stripe.subscriptions.update(subscriptionId, {
    items: [{ id: item.id, price: newPriceId }],
    proration_behavior: "none",
    metadata: meta,
  });
  await reconcileManagerPurchaseByStripeSubscriptionId(subscriptionId);

  // The deferred downgrade just took effect, which moves the included door
  // allowance down (e.g. Business's 120 -> Pro's 20) — the door-overage
  // quantity is stale the instant this lands. Best-effort: a failure here
  // must never fail the webhook (it would look like the renewal invoice
  // itself failed), just leave the quantity to catch up on the next sync.
  try {
    await syncManagerDoorQuantity({
      stripe,
      db: supabase,
      managerUserId: ownerUserId,
      stripeSubscriptionId: subscriptionId,
      tier: targetPaid,
    });
  } catch {
    /* best-effort; see comment above */
  }
}

/** Reconcile the row that owns this Stripe subscription id (webhook-safe). */
export async function reconcileManagerPurchaseByStripeSubscriptionId(subscriptionId: string): Promise<void> {
  const sid = subscriptionId.trim();
  if (!sid) return;

  const supabase = createSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .from("manager_purchases")
    .select("user_id")
    .eq("stripe_subscription_id", sid)
    .maybeSingle();
  if (error) throw new Error("Could not resolve subscription ownership.");

  const uid = data?.user_id != null ? String(data.user_id) : "";
  if (!uid) throw new Error("Could not resolve subscription ownership.");

  await reconcileManagerPurchaseWithStripe(uid);
}

/**
 * True only when Stripe definitively reports the subscription does not exist for
 * this account/mode (`resource_missing` / 404). Transient failures — network
 * errors, rate limits, auth errors, API outages — must NOT be treated as a
 * cancellation, or we would wipe a paying customer to free on a temporary blip.
 */
export function isDefinitiveStripeSubscriptionMissingError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; statusCode?: unknown; type?: unknown };
  if (e.code === "resource_missing") return true;
  return e.type === "StripeInvalidRequestError" && e.statusCode === 404;
}

/**
 * Aligns `manager_purchases` with the live Stripe Subscription when we have a stored
 * `stripe_subscription_id`. Fixes drift when webhooks lag or metadata was incomplete.
 */
export async function reconcileManagerPurchaseWithStripe(userId: string): Promise<void> {
  const supabase = createSupabaseServiceRoleClient();
  if ((await captureTestWorkspaceEffectForUser({
    userId,
    kind: "payment",
    summary: "Stripe subscription reconciliation was refused for a test workspace.",
    metadata: { operation: "subscription_reconciliation" },
    db: supabase,
  })).captured) return;

  const { data: purchase } = await supabase
    .from("manager_purchases")
    .select("stripe_subscription_id, stripe_checkout_session_id")
    .eq("user_id", userId)
    .maybeSingle();

  if (isAdminManagedManagerPurchase(purchase?.stripe_checkout_session_id)) return;

  const sid = purchase?.stripe_subscription_id?.trim();
  if (!sid) return;

  const stripe = getStripe();
  let sub: Stripe.Subscription;
  try {
    sub = await stripe.subscriptions.retrieve(sid, { expand: ["items.data.price"] });
  } catch (err) {
    // Only downgrade when Stripe confirms the subscription is gone. On any other
    // (transient / non-authoritative) error, keep the last known DB state.
    if (isDefinitiveStripeSubscriptionMissingError(err)) {
      await supabase
        .from("manager_purchases")
        .update({ tier: "free", billing: "free", stripe_subscription_id: null })
        .eq("user_id", userId);
    }
    return;
  }

  if (sub.status === "canceled" || sub.status === "incomplete_expired") {
    await supabase
      .from("manager_purchases")
      .update({ tier: "free", billing: "free", stripe_subscription_id: null })
      .eq("user_id", userId);
    return;
  }

  const periodEndSec = stripeSubscriptionPeriodEndSec(sub);
  const cancelAtPeriodEnd = Boolean((sub as { cancel_at_period_end?: boolean }).cancel_at_period_end);
  if (cancelAtPeriodEnd && periodEndSec && periodEndSec * 1000 <= Date.now()) {
    await supabase
      .from("manager_purchases")
      .update({ tier: "free", billing: "free", stripe_subscription_id: null })
      .eq("user_id", userId);
    return;
  }

  const item = sub.items.data[0];
  const priceId = typeof item?.price === "string" ? item.price : item?.price?.id ?? null;
  const paidTier = inferPaidTierFromStripePriceId(priceId);
  const billing = inferBillingFromStripePriceId(priceId);

  if (!paidTier || !billing) return;

  await supabase
    .from("manager_purchases")
    .update({
      tier: paidTier,
      billing,
      stripe_subscription_id: sub.id,
    })
    .eq("user_id", userId);
}
