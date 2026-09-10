import { ensureManagerBillingCustomer } from "@/lib/manager-stripe-customer.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { NextResponse } from "next/server";
import { resolveAppOrigin } from "@/lib/app-url";
import { resolveStripePriceIdForPaidTier } from "@/lib/stripe/resolve-manager-price";
import { buildManagerSubscriptionCheckoutBase } from "@/lib/stripe/subscription-checkout-session";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getStripe } from "@/lib/stripe";
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

    const body = (await req.json().catch(() => null)) as
      (Body & { embedded?: boolean }) | null;
    const tierRaw =
      typeof body?.tier === "string" ? body.tier.toLowerCase().trim() : "";
    const billingRaw =
      typeof body?.billing === "string"
        ? body.billing.toLowerCase().trim()
        : "";
    const baseRaw =
      typeof body?.returnBasePath === "string"
        ? body.returnBasePath.trim()
        : "/portal";
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

    void baseRaw;
    const basePath = "/portal";
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

    const metadata: Record<string, string> = {
      tier,
      billing,
      manager_id: managerId,
      email,
      userId: user.id,
    };
    const fn = profile?.full_name?.trim();
    if (fn) metadata.full_name = fn;

    const customer = await ensureManagerBillingCustomer(
      createSupabaseServiceRoleClient(),
      user.id,
    );
    const sessionBase = {
      ...buildManagerSubscriptionCheckoutBase({
        priceId: price,
        metadata,
        clientReferenceId: user.id,
        allowPromotionCodes: tier === "pro" && billing === "monthly",
      }),
      customer,
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
