import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isWaiverGrantedManagerPurchase } from "@/lib/manager-access";
import { getManagerPurchaseSku } from "@/lib/manager-access-server";
import { isAdminManagedManagerPurchase } from "@/lib/manager-admin-purchase";
import { getStripe } from "@/lib/stripe";
import { isSignupTrialManagerPurchase, managerPurchasePeriodEndMs } from "@/lib/manager-tier-expiry";
import { isTrialWorkNumberOnboardingEnabled } from "@/lib/sms/number-registration-policy";
import {
  getAcceptedCoManagerInviterIds,
  isPureCoManagerWorkspace,
} from "@/lib/sms/manager-workspace-role.server";

export type SmsEntitlementReason =
  | "free"
  | "trialing"
  | "past_due"
  | "canceled"
  | "legacy_unknown"
  | "plan_unreadable";

export type SmsEntitlement =
  | { eligible: true; tier: "pro" | "business"; source: "stripe" | "apple"; trial?: true }
  | { eligible: false; reason: SmsEntitlementReason };

type PurchaseSku = Awaited<ReturnType<typeof getManagerPurchaseSku>>;

function isCompGrant(purchase: {
  billing: string | null;
  stripeCheckoutSessionId: string | null;
  promoCode: string | null;
}): boolean {
  return purchase.billing === "admin" ||
    isAdminManagedManagerPurchase(purchase.stripeCheckoutSessionId) ||
    isWaiverGrantedManagerPurchase(purchase.promoCode);
}

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

async function reconcileTrialEntitlement(
  db: SupabaseClient,
  ownerId: string,
  tier: "pro" | "business",
  source: "stripe" | "none",
  trialEndMs: number | null,
): Promise<SmsEntitlement> {
  // Never turn a missing trial end into an unlimited communication grant.
  if (trialEndMs === null || !Number.isFinite(trialEndMs)) {
    return { eligible: false, reason: "plan_unreadable" };
  }
  let grantEndMs = trialEndMs;
  let enrolled = isTrialWorkNumberOnboardingEnabled();
  if (!enrolled && trialEndMs > Date.now()) {
    const { data, error } = await db.from("sms_manager_entitlements")
      .select("eligible, status, source, valid_until")
      .eq("manager_user_id", ownerId).maybeSingle();
    if (error) return { eligible: false, reason: "plan_unreadable" };
    // Closing enrollment does not cut off an already granted trial. It cannot
    // extend the original grant or carry it into another trial period.
    const storedEndMs = Date.parse(String(data?.valid_until));
    enrolled = data?.eligible === true && data.status === "trialing" &&
      data.source === source && Number.isFinite(storedEndMs) && storedEndMs > Date.now();
    if (enrolled) grantEndMs = Math.min(storedEndMs, trialEndMs);
  }
  const eligible = enrolled && trialEndMs > Date.now();
  const persisted = await persistEntitlement(db, ownerId, {
    tier, source, status: "trialing", eligible, validUntil: new Date(grantEndMs).toISOString(),
  });
  if (!persisted) return { eligible: false, reason: "plan_unreadable" };
  return eligible
    ? { eligible: true, tier, source: "stripe", trial: true }
    : { eligible: false, reason: trialEndMs <= Date.now() ? "canceled" : "trialing" };
}

/**
 * Reconcile the owner's SMS entitlement from the billing source. This is used
 * by explicit setup and billing webhooks, never by a browser-supplied owner id.
 * A transient billing/DB read failure returns ineligible without replacing a
 * previously observed state with invented data.
 *
 * Co-managers without their own paid plan may inherit eligibility from a linked
 * workspace owner when requesting their own work number (per-account, not shared).
 */
export async function reconcileManagerSmsEntitlement(
  db: SupabaseClient,
  managerUserId: string,
  deps: {
    preferPaid?: boolean;
    loadPurchase?: (id: string) => Promise<PurchaseSku>;
    loadStripeSubscription?: (id: string) => Promise<Stripe.Subscription>;
  } = {},
): Promise<SmsEntitlement> {
  const own = await reconcileManagerSmsEntitlementDirect(db, managerUserId, deps);
  if (own.eligible && (deps.preferPaid !== true || !own.trial)) return own;
  if (!(await isPureCoManagerWorkspace(db, managerUserId))) return own;
  for (const inviterId of await getAcceptedCoManagerInviterIds(db, managerUserId)) {
    const inherited = await reconcileManagerSmsEntitlementDirect(db, inviterId, deps);
    if (inherited.eligible && (deps.preferPaid !== true || !inherited.trial)) return inherited;
  }
  return own;
}

async function reconcileManagerSmsEntitlementDirect(
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
  //
  // Recognise the SAME three grant shapes the portal's own plan resolver does
  // (`resolveManagerSubscriptionTierFromPurchase`). Keying only on
  // `billing === "admin"` left a waiver-granted Business account reading back
  // as `legacy_unknown`: the portal showed them a paid plan and every other
  // paid feature worked, while Settings -> Messaging refused their number with
  // "a paid Pro or Business plan is required".
  if (isCompGrant(purchase)) {
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
    if (isSignupTrialManagerPurchase(purchase.billing)) {
      return reconcileTrialEntitlement(db, ownerId, tier, "none", managerPurchasePeriodEndMs({
        tier, billing: purchase.billing, paid_at: purchase.paidAt,
      }));
    }
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

  if (subscription.status === "trialing") {
    return reconcileTrialEntitlement(db, ownerId, tier, "stripe",
      subscription.trial_end ? subscription.trial_end * 1000 : null);
  }
  const eligible = subscription.status === "active";
  const validUntilSeconds = (subscription as Stripe.Subscription & { current_period_end?: number }).current_period_end;
  const validUntil = validUntilSeconds ? new Date(validUntilSeconds * 1000).toISOString() : null;
  const persisted = await persistEntitlement(db, ownerId, {
    tier,
    source: "stripe",
    status: eligible
      ? "active"
      : subscription.status === "past_due" || subscription.status === "unpaid" || subscription.status === "incomplete"
          ? "past_due"
          : "canceled",
    eligible,
    validUntil,
  });
  if (!persisted) return { eligible: false, reason: "plan_unreadable" };
  return eligible ? { eligible: true, tier, source: "stripe" } : { eligible: false, reason: stripeIneligibleReason(subscription.status) };
}

/** Stored entitlement, with co-manager inheritance from linked paid workspace owners. */
export async function getEffectiveManagerSmsEntitlement(
  db: SupabaseClient,
  managerUserId: string,
  options: { preferPaid?: boolean } = {},
): Promise<SmsEntitlement> {
  const own = await getStoredManagerSmsEntitlement(db, managerUserId);
  if (own.eligible && (options.preferPaid !== true || !own.trial)) return own;
  if (!(await isPureCoManagerWorkspace(db, managerUserId))) return own;
  for (const inviterId of await getAcceptedCoManagerInviterIds(db, managerUserId)) {
    const inherited = await getStoredManagerSmsEntitlement(db, inviterId);
    if (inherited.eligible && (options.preferPaid !== true || !inherited.trial)) return inherited;
  }
  return own;
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
  if (data.eligible === true && data.status === "trialing" && tier) {
    const trialEnd = Date.parse(String(data.valid_until ?? ""));
    if (!Number.isFinite(trialEnd)) return { eligible: false, reason: "plan_unreadable" };
    if (data.source === "stripe") return { eligible: true, tier, source: "stripe", trial: true };
    if (data.source === "none") {
      const { data: purchase, error: purchaseError } = await db.from("manager_purchases")
        .select("tier, billing, paid_at, stripe_subscription_id")
        .eq("user_id", managerUserId).maybeSingle();
      const currentTrialEnd = purchase ? managerPurchasePeriodEndMs(purchase) : null;
      if (purchaseError || !purchase || purchase.tier !== tier ||
        !isSignupTrialManagerPurchase(purchase.billing) || currentTrialEnd === null) {
        return { eligible: false, reason: "plan_unreadable" };
      }
      if (currentTrialEnd <= Date.now()) {
        return { eligible: false, reason: "canceled" };
      }
      return { eligible: true, tier, source: "stripe", trial: true };
    }
    return { eligible: false, reason: "plan_unreadable" };
  }
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
        .select("tier, billing, stripe_checkout_session_id, promo_code")
        .eq("user_id", managerUserId)
        .maybeSingle();
      if (purchaseError || !purchase || purchase.tier !== tier || !isCompGrant({
        billing: purchase.billing,
        stripeCheckoutSessionId: purchase.stripe_checkout_session_id,
        promoCode: purchase.promo_code,
      })) {
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
