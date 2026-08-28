import { NextResponse } from "next/server";
import { completeFreeManagerTierForUser } from "@/lib/auth/manager-pricing-selection";
import { generateManagerId } from "@/lib/manager-id";
import { newAxisIntentSessionId } from "@/lib/manager-signup-intent";
import { paymentWaiverCodeMatches } from "@/lib/server-env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

type Tier = "free" | "pro" | "business";
type Billing = "monthly" | "annual";

type Body = {
  tier?: string;
  billing?: string;
  email?: string;
  fullName?: string;
  phone?: string;
  promo?: string;
};

function isTier(s: string): s is Tier {
  return s === "free" || s === "pro" || s === "business";
}

function isBilling(s: string): s is Billing {
  return s === "monthly" || s === "annual";
}

/**
 * Creates a manager purchase row without Stripe (free tier only).
 * Returns session_id used by /auth/create-account and manager-signup.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    const tierRaw = typeof body.tier === "string" ? body.tier.toLowerCase().trim() : "";
    const billingRaw = typeof body.billing === "string" ? body.billing.toLowerCase().trim() : "";
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const fullName = typeof body.fullName === "string" ? body.fullName.trim() : "";
    const promo = typeof body.promo === "string" ? body.promo.trim().toUpperCase() : "";
    if (!email.includes("@")) {
      return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
    }
    if (!fullName) {
      return NextResponse.json({ error: "Enter your full name." }, { status: 400 });
    }
    if (!tierRaw || !billingRaw || !isTier(tierRaw) || !isBilling(billingRaw)) {
      return NextResponse.json({ error: "tier and billing are required." }, { status: 400 });
    }

    const skipStripeForFree = tierRaw === "free";
    const skipStripeForPromo = paymentWaiverCodeMatches(promo);

    if (!skipStripeForFree && !skipStripeForPromo) {
      return NextResponse.json(
        {
          error: "This tier requires Stripe checkout. Use Continue on the pricing page for paid plans.",
          code: "REQUIRES_CHECKOUT",
        },
        { status: 400 },
      );
    }

    const supabase = createSupabaseServiceRoleClient();
    const supabaseAuth = await createSupabaseServerClient();
    const {
      data: { user: authUser },
    } = await supabaseAuth.auth.getUser();

    if (authUser?.id && authUser.email?.trim().toLowerCase() === email) {
      try {
        const { managerId } = await completeFreeManagerTierForUser(supabase, {
          userId: authUser.id,
          email,
          fullName,
          tier: tierRaw,
          billing: billingRaw,
          promo: skipStripeForPromo ? promo : null,
        });
        return NextResponse.json({ action: "portal", managerId });
      } catch (e) {
        const message = e instanceof Error ? e.message : "Could not create signup.";
        if (message.includes("already exists")) {
          return NextResponse.json({ error: message }, { status: 409 });
        }
        throw e;
      }
    } else {
      const { data: purchasesForEmail } = await supabase.from("manager_purchases").select("user_id").eq("email", email);
      if (purchasesForEmail?.some((r) => r.user_id != null)) {
        return NextResponse.json(
          { error: "A manager account already exists for this email. Sign in instead." },
          { status: 409 },
        );
      }
    }

    const sessionId = newAxisIntentSessionId();
    const managerId = generateManagerId();

    const { error: insErr } = await supabase.from("manager_purchases").insert({
      stripe_checkout_session_id: sessionId,
      email,
      manager_id: managerId,
      tier: tierRaw,
      billing: billingRaw,
      promo_code: skipStripeForPromo ? promo : null,
      paid_at: new Date().toISOString(),
      full_name: fullName,
    });

    if (insErr) {
      return NextResponse.json({ error: insErr.message }, { status: 500 });
    }

    return NextResponse.json({ sessionId });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not create signup.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
