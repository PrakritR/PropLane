import { NextResponse } from "next/server";
import { findManagerPurchaseForAccount } from "@/lib/auth/manager-onboarding";
import {
  completeFreeManagerTierForUser,
  ensureProvisionedManagerForPricing,
} from "@/lib/auth/manager-pricing-selection";
import { completeManagerSignupTrial, isManagerSignupTrialTier } from "@/lib/auth/manager-signup-trial";
import { createManagerCheckoutSession } from "@/lib/stripe/manager-checkout";
import { getStripe } from "@/lib/stripe";
import { paymentWaiverCodeMatches } from "@/lib/server-env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { MANAGER_PORTAL_ENTRY_PATH } from "@/lib/auth/manager-google-services-onboarding";

export const runtime = "nodejs";

type Tier = "free" | "pro" | "business";
type Billing = "monthly" | "annual";

type Body = {
  tier?: string;
  billing?: string;
  promo?: string;
  phone?: string;
  trialSignup?: boolean;
};

function isTier(s: string): s is Tier {
  return s === "free" || s === "pro" || s === "business";
}

function isBilling(s: string): s is Billing {
  return s === "monthly" || s === "annual";
}

function oauthFullName(meta: Record<string, unknown> | null | undefined): string {
  const fullName = typeof meta?.full_name === "string" ? meta.full_name.trim() : "";
  if (fullName) return fullName;
  const name = typeof meta?.name === "string" ? meta.name.trim() : "";
  return name;
}

/**
 * After Google sign-in on partner pricing: create free intent or Stripe checkout
 * using the authenticated user's Google email/name (no manual form required).
 */
export async function POST(req: Request) {
  try {
    const supabaseAuth = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabaseAuth.auth.getUser();

    if (!user?.email) {
      return NextResponse.json({ error: "Sign in with Google first." }, { status: 401 });
    }

    const body = (await req.json()) as Body;
    const tierRaw = typeof body.tier === "string" ? body.tier.toLowerCase().trim() : "";
    const billingRaw = typeof body.billing === "string" ? body.billing.toLowerCase().trim() : "";
    const promo = typeof body.promo === "string" ? body.promo.trim().toUpperCase() : "";
    const phone = typeof body.phone === "string" ? body.phone.trim() : "";
    const trialSignup = body.trialSignup === true;

    if (!tierRaw || !billingRaw || !isTier(tierRaw) || !isBilling(billingRaw)) {
      return NextResponse.json({ error: "tier and billing are required." }, { status: 400 });
    }

    const email = user.email.trim().toLowerCase();
    const fullName = oauthFullName(user.user_metadata);

    const supabase = createSupabaseServiceRoleClient();
    const prepared = await ensureProvisionedManagerForPricing(supabase, {
      userId: user.id,
      email,
      fullName,
    });

    // Free tier NEVER touches Stripe: an account already exists (complete) just enters the
    // portal, and a pending account is finalized as Free right here, then enters the portal.
    // (There is no STRIPE_PRICE_FREE_MONTHLY, so routing Free through checkout would fail.)
    if (tierRaw === "free") {
      if (prepared.kind === "complete") {
        return NextResponse.json({ action: "portal", redirectTo: "/portal/dashboard" });
      }
      const { managerId: finalizedId } = await completeFreeManagerTierForUser(supabase, {
        userId: user.id,
        email,
        fullName,
        tier: "free",
        billing: billingRaw,
        promo,
      });
      return NextResponse.json({
        action: "portal",
        managerId: finalizedId,
        redirectTo: MANAGER_PORTAL_ENTRY_PATH,
      });
    }

    if (trialSignup && isManagerSignupTrialTier(tierRaw)) {
      if (prepared.kind === "complete") {
        return NextResponse.json({ action: "portal", redirectTo: "/portal/dashboard" });
      }
      const { managerId: finalizedId } = await completeManagerSignupTrial(supabase, {
        userId: user.id,
        email,
        fullName,
        tier: tierRaw,
      });
      return NextResponse.json({
        action: "portal",
        managerId: finalizedId,
        redirectTo: MANAGER_PORTAL_ENTRY_PATH,
      });
    }

    let managerId: string;
    if (prepared.kind === "complete") {
      const purchase = await findManagerPurchaseForAccount(supabase, user.id, email);
      managerId = purchase?.manager_id?.trim() ?? "";
      if (!managerId) {
        return NextResponse.json({ error: "Manager account not found." }, { status: 500 });
      }
    } else {
      managerId = prepared.managerId;
    }

    const skipStripeForPromo = paymentWaiverCodeMatches(promo);

    if (skipStripeForPromo) {
      const { managerId: finalizedId } = await completeFreeManagerTierForUser(supabase, {
        userId: user.id,
        email,
        fullName,
        tier: tierRaw,
        billing: billingRaw,
        promo,
      });
      return NextResponse.json({
        action: "portal",
        managerId: finalizedId,
        redirectTo: MANAGER_PORTAL_ENTRY_PATH,
      });
    }

    const checkout = await createManagerCheckoutSession({
      tier: tierRaw,
      billing: billingRaw,
      email,
      fullName,
      phone,
      userId: user.id,
      managerId,
      promo,
      embedded: true,
      req,
    });

    if (!checkout.ok) {
      return NextResponse.json({ error: checkout.error, code: checkout.code }, { status: checkout.status });
    }

    try {
      const stripe = getStripe();
      const session = await stripe.checkout.sessions.retrieve(checkout.sessionId);
      const reservedManagerId = session.metadata?.manager_id?.trim() ?? managerId;
      if (reservedManagerId) {
        const { error: reserveErr } = await supabase.from("manager_purchases").upsert(
          {
            stripe_checkout_session_id: checkout.sessionId,
            email,
            manager_id: reservedManagerId,
            full_name: fullName || null,
            user_id: user.id,
          },
          { onConflict: "manager_id" },
        );
        if (reserveErr) {
          return NextResponse.json({ error: reserveErr.message }, { status: 500 });
        }
      }
    } catch (reserveError) {
      const message = reserveError instanceof Error ? reserveError.message : "Could not reserve signup.";
      return NextResponse.json({ error: message }, { status: 500 });
    }

    if (checkout.embedded) {
      return NextResponse.json({
        action: "checkout",
        clientSecret: checkout.clientSecret,
        sessionId: checkout.sessionId,
      });
    }

    return NextResponse.json({ action: "redirect", url: checkout.url, sessionId: checkout.sessionId });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not continue signup.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
