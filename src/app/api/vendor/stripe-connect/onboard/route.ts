import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getStripe } from "@/lib/stripe";
import { ensureVendorConnectAccountId } from "@/lib/stripe-connect-account";
import {
  clearManagerConnectAccountId,
  connectAccountReadyForAchPayouts,
  connectAccountTransfersActive,
  ensureConnectAccountTransfersRequested,
  isStripeConnectAccountAccessError,
} from "@/lib/stripe-connect";

export const runtime = "nodejs";

/**
 * Ensures a Connect account exists for the signed-in vendor and reports its
 * readiness. PLAN-0920-0853: embedded onboarding (mounted via
 * `/api/vendor/stripe-connect/account-session`) replaces the redirect to
 * Stripe and the Express Dashboard login link — no Stripe-hosted URL here.
 */
export async function POST() {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
    if (String(profile?.role ?? "").toLowerCase() !== "vendor") {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    try {
      const stripe = getStripe();
      const accountId = await ensureVendorConnectAccountId(stripe, supabase, {
        userId: user.id,
        email: user.email ?? undefined,
      });

      const acct = await ensureConnectAccountTransfersRequested(stripe, accountId);

      return NextResponse.json({
        mode: "embedded" as const,
        accountId,
        connected: connectAccountTransfersActive(acct),
        paymentReady: connectAccountReadyForAchPayouts(acct),
        detailsSubmitted: Boolean(acct.details_submitted),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Stripe error";
      if (msg.includes("STRIPE_SECRET_KEY") || msg.includes("Missing STRIPE")) {
        return NextResponse.json(
          {
            code: "STRIPE_NOT_CONFIGURED",
            error: "Stripe is not configured (missing STRIPE_SECRET_KEY).",
          },
          { status: 503 },
        );
      }
      if (msg.includes("signed up for Connect")) {
        return NextResponse.json(
          {
            code: "CONNECT_NOT_ENABLED",
            error:
              "Stripe Connect is not activated yet. In the Stripe Dashboard (live mode), open Connect and complete setup, then try again.",
          },
          { status: 400 },
        );
      }
      if (isStripeConnectAccountAccessError(msg)) {
        await clearManagerConnectAccountId(supabase, user.id).catch(() => undefined);
        return NextResponse.json(
          {
            code: "CONNECT_ACCOUNT_STALE",
            error: "Your saved Stripe account is from an old setup. Refresh this page and connect payouts again.",
          },
          { status: 422 },
        );
      }
      return NextResponse.json({ code: "STRIPE_CONNECT_ERROR", error: msg }, { status: 400 });
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
