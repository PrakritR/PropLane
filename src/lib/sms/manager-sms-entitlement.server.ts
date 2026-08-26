import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getManagerPurchaseSku } from "@/lib/manager-access-server";
import { getStripe } from "@/lib/stripe";

export type SmsEntitlementReason =
  | "free"
  | "trialing"
  | "past_due"
  | "canceled"
  | "legacy_unknown"
  | "plan_unreadable";

export type SmsEntitlement =
  | { eligible: true; tier: "pro" | "business"; source: "stripe" | "apple" }
  | { eligible: false; reason: SmsEntitlementReason };

type PurchaseSku = Awaited<ReturnType<typeof getManagerPurchaseSku>>;

function paidTier(raw: string | null): "pro" | "business" | null {
  return raw === "pro" || raw === "business" ? raw : null;
}

async function persistEntitlement(
  db: SupabaseClient,
  managerUserId: string,
  input: {
    tier: "free" | "pro" | "business";
    source: "stripe" | "apple" | "none";
    status: "active" | "trialing" | "past_due" | "canceled" | "expired" | "unknown";
    eligible: boolean;
    validUntil?: string | null;
  },
): Promise<boolean> {
  const now = new Date().toISOString();
  const { error } = await db.from("sms_manager_entitlements").upsert(
    {
      manager_user_id: managerUserId,
      tier: input.tier,
      source: input.source,
      status: input.status,
      eligible: input.eligible,
      observed_at: now,
      valid_until: input.validUntil ?? null,
      updated_at: now,
    },
    { onConflict: "manager_user_id" },
  );
  return !error;
}

function stripeIneligibleReason(status: Stripe.Subscription.Status): SmsEntitlementReason {
  if (status === "trialing") return "trialing";
  if (status === "past_due" || status === "unpaid" || status === "incomplete") return "past_due";
  return "canceled";
}

/**
 * Reconcile the owner's SMS entitlement from the billing source. This is used
 * by explicit setup and billing webhooks, never by a browser-supplied owner id.
 * A transient billing/DB read failure returns ineligible without replacing a
 * previously observed state with invented data.
 */
export async function reconcileManagerSmsEntitlement(
  db: SupabaseClient,
  managerUserId: string,
  deps: {
    loadPurchase?: (id: string) => Promise<PurchaseSku>;
    loadStripeSubscription?: (id: string) => Promise<Stripe.Subscription>;
  } = {},
): Promise<SmsEntitlement> {
  const ownerId = managerUserId.trim();
  if (!ownerId) return { eligible: false, reason: "plan_unreadable" };

  const purchase = await (deps.loadPurchase ?? getManagerPurchaseSku)(ownerId);
  if (purchase.readFailed) return { eligible: false, reason: "plan_unreadable" };
  const tier = paidTier(purchase.tier);
  if (!tier) {
    const persisted = await persistEntitlement(db, ownerId, {
      tier: "free",
      source: "none",
      status: "active",
      eligible: false,
    });
    return persisted ? { eligible: false, reason: "free" } : { eligible: false, reason: "plan_unreadable" };
  }

  if (purchase.billing === "apple" && purchase.appleOriginalTransactionId) {
    const persisted = await persistEntitlement(db, ownerId, {
      tier,
      source: "apple",
      status: "active",
      eligible: true,
    });
    return persisted
      ? { eligible: true, tier, source: "apple" }
      : { eligible: false, reason: "plan_unreadable" };
  }

  // Admin / waiver-assigned paid tiers are intentional comp grants — they have no
  // Stripe subscription to revalidate, but they are still paid-plan eligible for
  // messaging. Persist as source "none" so GET can trust the entitlement row
  // without inventing a Stripe subscription id.
  if (purchase.billing === "admin" && tier) {
    const persisted = await persistEntitlement(db, ownerId, {
      tier,
      source: "none",
      status: "active",
      eligible: true,
    });
    return persisted
      ? { eligible: true, tier, source: "stripe" }
      : { eligible: false, reason: "plan_unreadable" };
  }

  const subscriptionId = purchase.stripeSubscriptionId?.trim();
  if (!subscriptionId) {
    return { eligible: false, reason: "legacy_unknown" };
  }

  let subscription: Stripe.Subscription;
  try {
    subscription = await (deps.loadStripeSubscription ?? ((id) => getStripe().subscriptions.retrieve(id)))(
      subscriptionId,
    );
  } catch {
    return { eligible: false, reason: "plan_unreadable" };
  }

  const eligible = subscription.status === "active";
  const validUntilSeconds = (subscription as Stripe.Subscription & { current_period_end?: number }).current_period_end;
  const validUntil = validUntilSeconds ? new Date(validUntilSeconds * 1000).toISOString() : null;
  const persisted = await persistEntitlement(db, ownerId, {
    tier,
    source: "stripe",
    status: eligible
      ? "active"
      : subscription.status === "trialing"
        ? "trialing"
        : subscription.status === "past_due" || subscription.status === "unpaid" || subscription.status === "incomplete"
          ? "past_due"
          : "canceled",
    eligible,
    validUntil,
  });
  if (!persisted) return { eligible: false, reason: "plan_unreadable" };
  return eligible ? { eligible: true, tier, source: "stripe" } : { eligible: false, reason: stripeIneligibleReason(subscription.status) };
}

/** Fast, fail-closed dispatch-time read. Billing reconciliation happens outside the hot path. */
export async function getStoredManagerSmsEntitlement(
  db: SupabaseClient,
  managerUserId: string,
): Promise<SmsEntitlement> {
  const { data, error } = await db
    .from("sms_manager_entitlements")
    .select("tier, source, status, eligible, valid_until")
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  if (error || !data) return { eligible: false, reason: "plan_unreadable" };
  if (data.valid_until && Date.parse(String(data.valid_until)) <= Date.now()) {
    return { eligible: false, reason: "canceled" };
  }
  const tier = paidTier(data.tier);
  if (data.eligible === true && data.status === "active" && tier) {
    if (data.source === "apple") {
      const { data: purchase, error: purchaseError } = await db
        .from("manager_purchases")
        .select("tier, billing, apple_original_transaction_id")
        .eq("user_id", managerUserId)
        .maybeSingle();
      if (
        purchaseError ||
        purchase?.billing !== "apple" ||
        purchase?.tier !== tier ||
        !String(purchase?.apple_original_transaction_id ?? "").trim()
      ) {
        return { eligible: false, reason: "plan_unreadable" };
      }
      return { eligible: true, tier, source: "apple" };
    }
    if (data.source === "none") {
      const { data: purchase, error: purchaseError } = await db
        .from("manager_purchases")
        .select("tier, billing")
        .eq("user_id", managerUserId)
        .maybeSingle();
      if (purchaseError || purchase?.billing !== "admin" || purchase?.tier !== tier) {
        return { eligible: false, reason: "plan_unreadable" };
      }
      // Admin-comp grants surface as stripe-shaped eligibility to callers; the
      // source column is only used to pick the revalidation path above.
      return { eligible: true, tier, source: "stripe" };
    }
    if (data.source === "stripe") {
      return { eligible: true, tier, source: "stripe" };
    }
    return { eligible: false, reason: "plan_unreadable" };
  }
  if (data.status === "trialing") return { eligible: false, reason: "trialing" };
  if (data.status === "past_due") return { eligible: false, reason: "past_due" };
  if (data.tier === "free") return { eligible: false, reason: "free" };
  return { eligible: false, reason: "canceled" };
}
