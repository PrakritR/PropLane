import { NextResponse } from "next/server";
import { type ManagerSkuTier } from "@/lib/manager-access";
import { getManagerPurchaseSku, setManagerPurchaseTier } from "@/lib/manager-access-server";
import {
  inferBillingFromStripePriceId,
  inferPaidTierFromStripePriceId,
  stripePriceIdForPaidTier,
  type PaidTier,
  type StripeBilling,
} from "@/lib/stripe-price-ids";
import { META_SCHEDULED_BILLING, META_SCHEDULED_TIER } from "@/lib/stripe-subscription-metadata";
import { track } from "@/lib/analytics/posthog";
import { getPaymentWaiverCode, normalizePaymentWaiverCode, paymentWaiverCodeMatches } from "@/lib/server-env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripe";
import { reconcileManagerPurchaseWithStripe } from "@/lib/manager-stripe-subscription-sync";
import { stripeSubscriptionPeriodEndSec } from "@/lib/stripe-subscription-helpers";

export const runtime = "nodejs";

function isSku(s: string): s is ManagerSkuTier {
  return s === "free" || s === "pro" || s === "business";
}

function paidTierRank(t: PaidTier): number {
  if (t === "pro") return 1;
  return 2;
}

function clearScheduleMetadata(meta: Record<string, string>): Record<string, string | null> {
  return {
    ...meta,
    [META_SCHEDULED_TIER]: null,
    [META_SCHEDULED_BILLING]: null,
  };
}

export async function POST(req: Request) {
  try {
    const supabaseAuth = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabaseAuth.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const body = (await req.json().catch(() => null)) as
      | { tier?: string; billing?: string; resume?: boolean; action?: string; promo?: string }
      | null;

    if (body?.resume === true || body?.action === "resume") {
      const { stripeSubscriptionId } = await getManagerPurchaseSku(user.id);
      if (!stripeSubscriptionId) {
        return NextResponse.json({ error: "No active subscription to resume." }, { status: 400 });
      }
      const stripe = getStripe();
      const existing = await stripe.subscriptions.retrieve(stripeSubscriptionId);
      const meta = clearScheduleMetadata({ ...(existing.metadata ?? {}) });
      await stripe.subscriptions.update(stripeSubscriptionId, {
        cancel_at_period_end: false,
        metadata: meta,
      });
      await reconcileManagerPurchaseWithStripe(user.id);
      return NextResponse.json({ ok: true, resumed: true });
    }

    if (body?.action === "cancel_downgrade") {
      const { stripeSubscriptionId } = await getManagerPurchaseSku(user.id);
      if (!stripeSubscriptionId) {
        return NextResponse.json({ error: "No active subscription found." }, { status: 400 });
      }
      const stripe = getStripe();
      const existing = await stripe.subscriptions.retrieve(stripeSubscriptionId);
      const meta = clearScheduleMetadata({ ...(existing.metadata ?? {}) });
      await stripe.subscriptions.update(stripeSubscriptionId, { metadata: meta });
      await reconcileManagerPurchaseWithStripe(user.id);
      return NextResponse.json({ ok: true, canceledDowngrade: true });
    }

    const tierRaw = typeof body?.tier === "string" ? body.tier.toLowerCase().trim() : "";
    if (!isSku(tierRaw)) {
      return NextResponse.json({ error: "tier must be free, pro, or business." }, { status: 400 });
    }

    const billingBody = typeof body?.billing === "string" ? body.billing.toLowerCase().trim() : "";
    const billingRequested: StripeBilling | null =
      billingBody === "monthly" || billingBody === "annual" ? billingBody : null;

    // Payment-waiver promo code (same validation as signup-intent / pricing-oauth-continue).
    const promo = typeof body?.promo === "string" ? body.promo : "";
    const waiverValid = paymentWaiverCodeMatches(promo);
    const promoStored = waiverValid ? normalizePaymentWaiverCode(getPaymentWaiverCode() ?? "") : "";
    if (promo.trim() && !waiverValid) {
      return NextResponse.json(
        { error: "That promo code isn't valid.", code: "INVALID_PROMO" },
        { status: 400 },
      );
    }

    const targetTier = tierRaw;
    const { stripeSubscriptionId } = await getManagerPurchaseSku(user.id);
    const supabase = createSupabaseServiceRoleClient();

    if (!stripeSubscriptionId) {
      if (targetTier === "free") {
        const result = await setManagerPurchaseTier(user.id, "free");
        if (!result.ok) {
          return NextResponse.json({ error: result.error }, { status: 400 });
        }
        return NextResponse.json({ ok: true, stripeManaged: false, tier: "free" });
      }
      if (waiverValid) {
        const billing: StripeBilling = billingRequested ?? "monthly";
        const result = await setManagerPurchaseTier(user.id, targetTier, {
          waiver: { promoCode: promoStored, billing },
        });
        if (!result.ok) {
          return NextResponse.json({ error: result.error }, { status: 400 });
        }
        track("manager_subscription_purchased", user.id, { tier: targetTier, billing, waiver: true });
        return NextResponse.json({
          ok: true,
          stripeManaged: false,
          waiverApplied: true,
          tier: targetTier,
          billing,
          message: `Promo code applied — you're now on ${targetTier === "business" ? "Business" : "Pro"}. No payment needed.`,
        });
      }
      return NextResponse.json(
        { error: "Start checkout to subscribe to a paid plan." },
        { status: 402 },
      );
    }

    if (waiverValid && targetTier !== "free") {
      return NextResponse.json(
        {
          error:
            "Your subscription is billed through Stripe, so promo codes can't be applied here. Manage billing from Payment & invoices.",
          code: "PROMO_NOT_APPLICABLE",
        },
        { status: 400 },
      );
    }

    const stripe = getStripe();

    if (targetTier === "free") {
      try {
        const existing = await stripe.subscriptions.retrieve(stripeSubscriptionId);
        const st = (existing as { status?: string }).status;
        const terminal = st === "canceled" || st === "incomplete_expired";
        if (!terminal) {
          const meta = clearScheduleMetadata({ ...(existing.metadata ?? {}) });
          await stripe.subscriptions.update(stripeSubscriptionId, {
            cancel_at_period_end: true,
            metadata: meta,
          });
        }
      } catch (e: unknown) {
        const code =
          typeof e === "object" && e !== null && "code" in e ? String((e as { code?: string }).code) : "";
        const msg = e instanceof Error ? e.message : String(e);
        const missing = code === "resource_missing" || msg.toLowerCase().includes("no such subscription");
        if (!missing) throw e;
      }

      return NextResponse.json({
        ok: true,
        stripeManaged: true,
        cancelAtPeriodEnd: true,
        message: "Subscription will end at the close of your current billing period. You keep paid features until then.",
      });
    }

    const sub = await stripe.subscriptions.retrieve(stripeSubscriptionId);
    const item = sub.items.data[0];
    if (!item?.id) {
      return NextResponse.json({ error: "Subscription has no line item." }, { status: 500 });
    }

    const currentPriceId = typeof item.price === "string" ? item.price : item.price?.id;
    const billingGuess = inferBillingFromStripePriceId(currentPriceId) ?? "monthly";
    const currentBilling: StripeBilling = billingGuess === "annual" ? "annual" : "monthly";

    const targetPaid: PaidTier = targetTier === "business" ? "business" : "pro";
    const targetBilling: StripeBilling = billingRequested ?? currentBilling;

    const newPriceId = stripePriceIdForPaidTier(targetPaid, targetBilling)?.trim();
    if (!newPriceId) {
      return NextResponse.json(
        {
          error: `Missing Stripe price for ${targetPaid} ${targetBilling}. Set STRIPE_PRICE_* env vars.`,
        },
        { status: 500 },
      );
    }

    const currentPaidTier = inferPaidTierFromStripePriceId(currentPriceId);

    if (currentPaidTier && paidTierRank(targetPaid) < paidTierRank(currentPaidTier)) {
      const periodEnd = stripeSubscriptionPeriodEndSec(sub);
      const meta = {
        ...(sub.metadata ?? {}),
        [META_SCHEDULED_TIER]: targetPaid,
        [META_SCHEDULED_BILLING]: targetBilling,
      };
      await stripe.subscriptions.update(stripeSubscriptionId, {
        metadata: meta,
        cancel_at_period_end: false,
      });
      await reconcileManagerPurchaseWithStripe(user.id);
      return NextResponse.json({
        ok: true,
        stripeManaged: true,
        scheduledDowngrade: true,
        scheduledTier: targetPaid,
        scheduledBilling: targetBilling,
        effectiveAt: periodEnd,
        message: `Your plan will change to ${targetPaid} (${targetBilling}) at the start of your next billing cycle.`,
      });
    }

    const annualToMonthlySameTier =
      currentPaidTier !== null &&
      targetPaid === currentPaidTier &&
      currentBilling === "annual" &&
      targetBilling === "monthly";

    if (annualToMonthlySameTier) {
      const periodEnd = stripeSubscriptionPeriodEndSec(sub);
      const meta = {
        ...(sub.metadata ?? {}),
        [META_SCHEDULED_TIER]: targetPaid,
        [META_SCHEDULED_BILLING]: "monthly",
      };
      await stripe.subscriptions.update(stripeSubscriptionId, {
        metadata: meta,
        cancel_at_period_end: false,
      });
      await reconcileManagerPurchaseWithStripe(user.id);
      return NextResponse.json({
        ok: true,
        stripeManaged: true,
        scheduledDowngrade: true,
        scheduledTier: targetPaid,
        scheduledBilling: "monthly",
        scheduledBillingChange: true,
        effectiveAt: periodEnd,
        message:
          "Your plan will switch to monthly billing at the end of your current annual period. You'll keep annual billing until then.",
      });
    }

    if (currentPriceId === newPriceId) {
      const meta = clearScheduleMetadata({ ...(sub.metadata ?? {}) });
      await stripe.subscriptions.update(stripeSubscriptionId, { metadata: meta });
      await supabase.from("manager_purchases").update({ tier: targetPaid, billing: targetBilling }).eq("user_id", user.id);
      return NextResponse.json({ ok: true, stripeManaged: true, tier: targetPaid, billing: targetBilling });
    }

    const isUpgradeTier = currentPaidTier === null || paidTierRank(targetPaid) > paidTierRank(currentPaidTier);
    const sameTierDifferentPrice =
      currentPaidTier !== null &&
      paidTierRank(targetPaid) === paidTierRank(currentPaidTier) &&
      currentPriceId !== newPriceId;
    const monthlyToAnnualSameTier =
      sameTierDifferentPrice && currentBilling === "monthly" && targetBilling === "annual";
    const useProration = isUpgradeTier || monthlyToAnnualSameTier;

    const switchingMonthlyToAnnual = currentBilling === "monthly" && targetBilling === "annual";
    const annualSwitchCoupon = process.env.STRIPE_COUPON_SWITCH_TO_ANNUAL?.trim();

    const meta = clearScheduleMetadata({ ...(sub.metadata ?? {}) });

    await stripe.subscriptions.update(stripeSubscriptionId, {
      items: [{ id: item.id, price: newPriceId }],
      proration_behavior: useProration ? "create_prorations" : "none",
      cancel_at_period_end: false,
      metadata: meta,
      ...(switchingMonthlyToAnnual && annualSwitchCoupon ? { discounts: [{ coupon: annualSwitchCoupon }] } : {}),
    });

    const { error: upErr } = await supabase
      .from("manager_purchases")
      .update({ tier: targetPaid, billing: targetBilling })
      .eq("user_id", user.id);

    if (upErr) {
      return NextResponse.json({ error: upErr.message }, { status: 500 });
    }

    await reconcileManagerPurchaseWithStripe(user.id);

    return NextResponse.json({
      ok: true,
      stripeManaged: true,
      tier: targetPaid,
      billing: targetBilling,
      message: useProration
        ? "Plan updated — Stripe will invoice any proration to your saved payment method."
        : "Billing interval updated.",
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
