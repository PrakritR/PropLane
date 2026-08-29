import { NextResponse } from "next/server";
import {
  formatManagerMonthlyLabel,
  isBusinessSkuTier,
  isProSkuTier,
  maxAccountLinksForTier,
  maxPropertiesForManagerTier,
  monthlyUsdForManagerTier,
  PRO_MAX_PROPERTIES,
  resolveEffectiveManagerSkuTier,
} from "@/lib/manager-access";
import { getManagerPurchaseSku } from "@/lib/manager-access-server";
import { isAppleBilledManagerPurchase } from "@/lib/manager-apple-purchase";
import { getStripe } from "@/lib/stripe";
import {
  stripeSubscriptionIsBillable,
  stripeSubscriptionPeriodEndSec,
} from "@/lib/stripe-subscription-helpers";
import { META_SCHEDULED_BILLING, META_SCHEDULED_TIER } from "@/lib/stripe-subscription-metadata";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { syncManagerPurchaseTierState } from "@/lib/manager-tier-sync";

export const runtime = "nodejs";

function subscriptionJson(
  tier: string | null,
  billing: string | null,
  opts: { stripeSubscriptionId: string | null; appleManaged: boolean; planUnknown: boolean },
) {
  const t = tier?.toLowerCase() ?? null;
  /**
   * The plan the product HOLDS this account to. It exists because `tier` alone
   * disagreed with the rest of this response: an account whose purchase row has
   * no committed SKU reported `isFree: true` and `propertyLimit: null`, so
   * Settings said "Free · 1 property listing" beside a Properties tab with no
   * cap at all (audit F-SET-1). Every quota below is derived from this, and
   * `POST /api/property-records` re-resolves the same value server-side.
   *
   * A plan we could not READ is not a plan. A failed purchase-row read also
   * arrives as `tier: null`, which resolves to Free — so reporting it would
   * hand a paying manager `propertyLimit: 1`, draw the red "reached your plan
   * limit" banner and pre-refuse "+ Add property" for the whole session, while
   * the route that pre-check is previewing would answer 500 rather than a Free
   * refusal. Unknown means the client stops pre-judging and lets the server
   * decide; nothing is waved through, because that server gate fails closed.
   */
  const effective = opts.planUnknown
    ? null
    : resolveEffectiveManagerSkuTier({
        tier: t,
        stripeSubscriptionId: opts.stripeSubscriptionId,
        appleManaged: opts.appleManaged,
      });
  return {
    tier: t,
    effectiveTier: effective,
    planUnknown: opts.planUnknown,
    billing,
    isPro: isProSkuTier(t),
    isBusiness: isBusinessSkuTier(t),
    isFree: t === "free",
    /** No purchase row — legacy / unknown; not treated as Pro-capped. */
    isLegacyUnlimited: t === null,
    proPropertyLimit: PRO_MAX_PROPERTIES,
    propertyLimit: opts.planUnknown ? null : maxPropertiesForManagerTier(effective),
    accountLinkLimit: opts.planUnknown ? null : maxAccountLinksForTier(effective),
    monthlyAmountUsd: monthlyUsdForManagerTier(t),
    monthlyLabel: formatManagerMonthlyLabel(t),
  };
}

export async function GET() {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    try {
      await syncManagerPurchaseTierState(user.id);
    } catch {
      /* Stripe not configured or transient error — serve last known DB state */
    }

    const { tier, billing, stripeSubscriptionId, appleOriginalTransactionId, readFailed } =
      await getManagerPurchaseSku(user.id);
    let stripeManaged = false;
    try {
      stripeManaged = await stripeSubscriptionIsBillable(stripeSubscriptionId);
    } catch {
      /* Stripe not configured or transient error — treat as not Stripe-managed */
    }
    // Apple-billed grant → the plan is managed in the App Store: on native we
    // don't re-offer IAP, on web we hide Stripe checkout (report §3.4).
    const appleManaged = isAppleBilledManagerPurchase(billing, appleOriginalTransactionId);
    const base = subscriptionJson(tier, billing, {
      stripeSubscriptionId,
      appleManaged,
      planUnknown: readFailed,
    });
    const missingTier = tier == null || String(tier).trim() === "";
    /** Treat missing tier row as Free in the plan UI when there is no paid Stripe subscription. */
    const isFree = !readFailed && (base.isFree || (missingTier && !stripeManaged && !appleManaged));

    let cancelAtPeriodEnd = false;
    let currentPeriodEnd: number | null = null;
    let scheduledDowngrade: { tier: string; billing: string } | null = null;

    if (stripeManaged && stripeSubscriptionId) {
      try {
        const stripe = getStripe();
        const sub = await stripe.subscriptions.retrieve(stripeSubscriptionId);
        cancelAtPeriodEnd = Boolean((sub as { cancel_at_period_end?: boolean }).cancel_at_period_end);
        currentPeriodEnd = stripeSubscriptionPeriodEndSec(sub);
        const st = sub.metadata?.[META_SCHEDULED_TIER]?.trim().toLowerCase();
        const sb = sub.metadata?.[META_SCHEDULED_BILLING]?.trim().toLowerCase();
        if (!cancelAtPeriodEnd && (st === "pro" || st === "business") && (sb === "monthly" || sb === "annual")) {
          scheduledDowngrade = { tier: st, billing: sb };
        }
      } catch {
        /* ignore */
      }
    }

    return NextResponse.json({
      ...base,
      isFree,
      stripeManaged,
      appleManaged,
      cancelAtPeriodEnd,
      currentPeriodEnd,
      scheduledDowngrade,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Set tier (free / pro / business) or legacy one-shot upgrade to Business. */
export async function POST(req: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const body = (await req.json().catch(() => null)) as
      | { action?: string; tier?: string }
      | null;

    if (body?.action === "set_tier" || body?.action === "upgrade_business") {
      return NextResponse.json(
        { error: "Plan changes must go through checkout, billing settings, or an admin assignment." },
        { status: 403 },
      );
    }

    return NextResponse.json({ error: "Unsupported action." }, { status: 400 });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
