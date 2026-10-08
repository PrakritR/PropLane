import { ensureManagerBillingCustomer } from "@/lib/manager-stripe-customer.server";
import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";
import { NextResponse } from "next/server";
import { resolveAppOrigin } from "@/lib/app-url";
import { resolveStripePriceIdForPaidTier } from "@/lib/stripe/resolve-manager-price";
import { buildManagerSubscriptionCheckoutBase } from "@/lib/stripe/subscription-checkout-session";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getStripe } from "@/lib/stripe";
import { checkoutSessionIndicatesPaidPurchase, recordPaidManagerCheckoutSession } from "@/lib/manager-purchase-from-session";
import { assertTestWorkspaceProviderEffectAllowed } from "@/lib/test-workspaces/effects.server";
import {
  MANAGER_PLAN_CHECKOUT_CANCELLED_PATH,
  MANAGER_PLAN_CHECKOUT_SUCCESS_PATH,
} from "@/lib/portals/manager-plan-path";

export const runtime = "nodejs";

type Body = {
  tier?: string;
  billing?: string;
  /** Legacy callers may send a portal base; checkout now returns to the unified property portal. */
  returnBasePath?: string;
};

function isPaidTier(s: string): s is "pro" | "business" {
  return s === "pro" || s === "business";
}

function isBilling(s: string): s is "monthly" | "annual" {
  return s === "monthly" || s === "annual";
}

/**
 * Authenticated Stripe Checkout for upgrading an existing manager/owner from Free (or non-Stripe billing)
 * to Pro or Business. Links the subscription to `profiles` via metadata `userId` for webhook upsert.
 */
export async function POST(req: Request) {
  try {
    const supabaseAuth = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabaseAuth.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    await assertTestWorkspaceProviderEffectAllowed({
      userId: user.id,
      kind: "payment",
      summary: "Subscription checkout refused for a test workspace.",
    });

    const actor = await requireManagerRouteUser();
    if (!actor || actor.userId !== user.id) {
      return NextResponse.json({ error: "Manager access required." }, { status: 403 });
    }

    const body = (await req.json().catch(() => null)) as
      (Body & { embedded?: boolean }) | null;
    const tierRaw =
      typeof body?.tier === "string" ? body.tier.toLowerCase().trim() : "";
    const billingRaw =
      typeof body?.billing === "string"
        ? body.billing.toLowerCase().trim()
        : "";
    const useEmbedded = body?.embedded !== false;

    if (!isPaidTier(tierRaw) || !isBilling(billingRaw)) {
      return NextResponse.json(
        {
          error:
            "tier must be pro or business; billing must be monthly or annual.",
        },
        { status: 400 },
      );
    }

    const tier = tierRaw;
    const billing = billingRaw;

    const price = await resolveStripePriceIdForPaidTier(tier, billing);
    if (!price) {
      return NextResponse.json(
        {
          error: `No Stripe price found for ${tier} ${billing}. Set lookup_key axis_manager_${tier}_${billing} on the active Stripe price.`,
        },
        { status: 500 },
      );
    }

    const appUrl = resolveAppOrigin(req);

    const returnUrl = `${appUrl}${MANAGER_PLAN_CHECKOUT_SUCCESS_PATH}`;

    const { data: profile, error: profileErr } = await supabaseAuth
      .from("profiles")
      .select("email, manager_id, full_name")
      .eq("id", user.id)
      .maybeSingle();

    if (profileErr) {
      return NextResponse.json({ error: profileErr.message }, { status: 500 });
    }
    const email = (profile?.email ?? user.email ?? "").trim().toLowerCase();
    const managerId = profile?.manager_id?.trim();
    if (!email?.includes("@")) {
      return NextResponse.json(
        { error: "Your account needs an email before subscribing." },
        { status: 400 },
      );
    }
    if (!managerId) {
      return NextResponse.json(
        { error: "Your profile is missing a PropLane ID. Contact support." },
        { status: 400 },
      );
    }

    const stripe = getStripe();

    // A portal Checkout has to own a durable purchase row before its secret
    // reaches the browser. Otherwise a completed $49/$249 session cannot pass
    // resolveManagerCheckoutPurchase and the manager remains on Free.
    const { data: purchase, error: purchaseError } = await actor.db.from("manager_purchases")
      .select("id,user_id,email,manager_id,tier,billing,stripe_subscription_id,stripe_checkout_session_id,apple_original_transaction_id")
      .eq("manager_id", managerId).maybeSingle();
    if (purchaseError || (purchase && (purchase.user_id !== user.id ||
        String(purchase.email ?? "").trim().toLowerCase() !== email))) {
      return NextResponse.json({ error: "Your manager billing record needs to be reconciled before checkout." }, { status: 409 });
    }
    if (!purchase) {
      const { data: otherPurchases, error: otherError } = await actor.db.from("manager_purchases")
        .select("id").eq("user_id", user.id).limit(2);
      if (otherError || (otherPurchases?.length ?? 0) > 0) {
        return NextResponse.json({ error: "Your manager billing record needs to be reconciled before checkout." }, { status: 409 });
      }
    }
    // A signup trial grants a temporary Pro/Business entitlement without a
    // paid Stripe or Apple subscription. Preserve that row until a verified
    // Checkout fulfills it, including a same-tier activation.
    const signupTrial = purchase?.billing === "trial" &&
      (purchase.tier === "pro" || purchase.tier === "business") &&
      !purchase.stripe_subscription_id && !purchase.apple_original_transaction_id;
    if (purchase && (purchase.stripe_subscription_id || purchase.apple_original_transaction_id ||
        (purchase.tier !== null && purchase.tier !== "free" && !signupTrial))) {
      return NextResponse.json({ error: "Manage your existing paid plan from Billing instead of starting another subscription." }, { status: 409 });
    }
    const customer = await ensureManagerBillingCustomer(actor.db, user.id);
    const priorSessionId = String(purchase?.stripe_checkout_session_id ?? "").trim();
    const prior = priorSessionId.startsWith("cs_")
      ? await stripe.checkout.sessions.retrieve(priorSessionId) : null;
    if (prior) {
      const priorCustomer = typeof prior.customer === "string" ? prior.customer : prior.customer?.id;
      if (prior.metadata?.userId !== user.id || prior.metadata?.manager_id !== managerId ||
          prior.mode !== "subscription" || priorCustomer !== customer) {
        return NextResponse.json({ error: "An earlier subscription checkout needs reconciliation." }, { status: 409 });
      }
      if (prior.status === "complete") {
        if (checkoutSessionIndicatesPaidPurchase(prior)) {
          await recordPaidManagerCheckoutSession(prior);
          return NextResponse.json({ error: "Your previous subscription payment completed. Refresh Billing to see the plan." }, { status: 409 });
        }
        return NextResponse.json({ error: "Your previous subscription payment is still processing." }, { status: 409 });
      }
    }
    // A legacy Free account can lack a local purchase row while its Stripe
    // customer already has a subscription. Provider truth blocks a second one.
    const subscriptions = await stripe.subscriptions.list({ customer, status: "all", limit: 20 });
    if (subscriptions.has_more || subscriptions.data.some((sub) => !["canceled", "incomplete_expired"].includes(sub.status))) {
      return NextResponse.json({ error: "A subscription already exists for this billing account. Refresh Billing before starting another." }, { status: 409 });
    }
    if (prior) {
      if (prior.status === "open") {
        if (prior.metadata?.tier === tier && prior.metadata?.billing === billing &&
            prior.metadata?.floor_price_id === price &&
            (useEmbedded ? Boolean(prior.client_secret) : Boolean(prior.url))) {
          return NextResponse.json(useEmbedded
            ? { clientSecret: prior.client_secret, sessionId: prior.id, embedded: true }
            : { url: prior.url, sessionId: prior.id, embedded: false });
        }
        // Old open sessions may carry a retired price or a different billing
        // cadence. Expire them before replacing their reserved attempt.
        await stripe.checkout.sessions.expire(prior.id);
      }
      if (prior.status !== "expired" && prior.status !== "open") {
        return NextResponse.json({ error: "Your previous subscription payment is still processing." }, { status: 409 });
      }
    }

    const metadata: Record<string, string> = {
      tier,
      billing,
      floor_price_id: price,
      manager_id: managerId,
      email,
      userId: user.id,
    };
    const fn = profile?.full_name?.trim();
    if (fn) metadata.full_name = fn;

    const sessionBase = {
      ...buildManagerSubscriptionCheckoutBase({
        priceId: price,
        metadata,
        clientReferenceId: user.id,
        allowPromotionCodes: true,
      }),
      customer,
    };

    const reserve = async (sessionId: string): Promise<boolean> => {
      let result: { data: { id: string } | null; error: { message: string } | null };
      if (purchase) {
        let query = actor.db.from("manager_purchases").update({ stripe_checkout_session_id: sessionId })
          .eq("id", purchase.id).eq("user_id", user.id).eq("manager_id", managerId)
          .is("stripe_subscription_id", null).is("apple_original_transaction_id", null);
        query = priorSessionId ? query.eq("stripe_checkout_session_id", priorSessionId)
          : query.is("stripe_checkout_session_id", null);
        query = purchase.tier === null ? query.is("tier", null) : query.eq("tier", purchase.tier);
        if (signupTrial) query = query.eq("billing", "trial");
        result = await query.select("id").maybeSingle();
      } else {
        result = await actor.db.from("manager_purchases").insert({
            user_id: user.id, manager_id: managerId, email,
            full_name: profile?.full_name?.trim() || null,
            tier: "free", billing: "monthly", stripe_checkout_session_id: sessionId,
          }).select("id").maybeSingle();
      }
      const { data, error } = result;
      if (error) {
        await stripe.checkout.sessions.expire(sessionId).catch(() => undefined);
        throw new Error("Could not reserve manager checkout ownership.");
      }
      return Boolean(data?.id);
    };

    if (useEmbedded) {
      const session = await stripe.checkout.sessions.create({
        ui_mode: "embedded_page",
        ...sessionBase,
        return_url: returnUrl,
      } as Parameters<typeof stripe.checkout.sessions.create>[0]);

      if (!session.client_secret) {
        return NextResponse.json(
          { error: "Stripe did not return a checkout client secret." },
          { status: 500 },
        );
      }

      if (!(await reserve(session.id))) {
        await stripe.checkout.sessions.expire(session.id).catch(() => undefined);
        return NextResponse.json({ error: "Another checkout already started for this manager. Refresh Billing." }, { status: 409 });
      }

      return NextResponse.json({
        clientSecret: session.client_secret,
        sessionId: session.id,
        embedded: true,
      });
    }

    const session = await stripe.checkout.sessions.create({
      ui_mode: "hosted_page",
      ...sessionBase,
      success_url: returnUrl,
      cancel_url: `${appUrl}${MANAGER_PLAN_CHECKOUT_CANCELLED_PATH}`,
    } as Parameters<typeof stripe.checkout.sessions.create>[0]);

    if (!session.url) {
      return NextResponse.json(
        { error: "Stripe did not return a checkout URL." },
        { status: 500 },
      );
    }

    if (!(await reserve(session.id))) {
      await stripe.checkout.sessions.expire(session.id).catch(() => undefined);
      return NextResponse.json({ error: "Another checkout already started for this manager. Refresh Billing." }, { status: 409 });
    }

    return NextResponse.json({
      url: session.url,
      sessionId: session.id,
      embedded: false,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Checkout failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
