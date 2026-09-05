import { NextResponse } from "next/server";
import { resolveAppOrigin } from "@/lib/app-url";
import { assertCoManagerBankAccountAccess } from "@/lib/auth/co-manager-bank-account-access";
import { resolveStripePayoutContext } from "@/lib/auth/manager-stripe-payout-access.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getStripe, stripeConnectRedirectOriginError } from "@/lib/stripe";
import { ensureManagerConnectAccountId } from "@/lib/stripe-connect-account";
import {
  connectAccountReadyForAchPayouts,
  ensureConnectAccountTransfersRequested,
  isStripeConnectAccountAccessError,
} from "@/lib/stripe-connect";

export const runtime = "nodejs";

/**
 * Creates or resumes Stripe Connect onboarding for the signed-in user.
 * Returns an Account Link URL — the client opens a blank tab on click, then navigates after POST.
 */
export async function POST(req: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const service = createSupabaseServiceRoleClient();
    const payout = await resolveStripePayoutContext(service, user.id);
    if (!payout.payoutOwnerUserId) {
      return NextResponse.json({ error: "Could not resolve payout account." }, { status: 500 });
    }
    const access = await assertCoManagerBankAccountAccess(
      service,
      user.id,
      payout.payoutOwnerUserId,
      "edit",
    );
    if (!access.ok) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }

    const payoutOwnerId = payout.payoutOwnerUserId;
    const { data: ownerProfile } = await service
      .from("profiles")
      .select("email")
      .eq("id", payoutOwnerId)
      .maybeSingle();

    const basePath = "/portal";
    const origin = resolveAppOrigin(req);
    const redirectError = stripeConnectRedirectOriginError(origin);
    if (redirectError) {
      return NextResponse.json(
        { code: "LIVEMODE_REQUIRES_HTTPS", error: redirectError },
        { status: 422 },
      );
    }

    const refreshUrl = `${origin}${basePath}/payments?connect=refresh`;
    const returnUrl = `${origin}${basePath}/payments?connect=done`;

    try {
      const stripe = getStripe();
      const accountId = await ensureManagerConnectAccountId(stripe, supabase, {
        userId: payoutOwnerId,
        email: ownerProfile?.email ?? user.email ?? undefined,
      });

      const acct = await ensureConnectAccountTransfersRequested(stripe, accountId);
      const readyForPayouts = connectAccountReadyForAchPayouts(acct);

      if (readyForPayouts) {
        const loginLink = await stripe.accounts.createLoginLink(accountId);
        return NextResponse.json({
          url: loginLink.url,
          accountId,
          mode: "express_dashboard" as const,
        });
      }

      const linkType = acct.details_submitted ? "account_update" : "account_onboarding";
      const accountLink = await stripe.accountLinks.create({
        account: accountId,
        refresh_url: refreshUrl,
        return_url: returnUrl,
        type: linkType,
      });

      return NextResponse.json({
        url: accountLink.url,
        accountId,
        mode: linkType === "account_onboarding" ? ("onboarding" as const) : ("update" as const),
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
      if (msg.includes("redirected via HTTPS") || msg.toLowerCase().includes("https")) {
        return NextResponse.json(
          {
            code: "LIVEMODE_REQUIRES_HTTPS",
            error:
              "Live Stripe requires HTTPS return URLs. Use test keys locally, or set NEXT_PUBLIC_APP_URL to your production https URL.",
          },
          { status: 422 },
        );
      }
      if (isStripeConnectAccountAccessError(msg)) {
        return NextResponse.json(
          {
            code: "CONNECT_ACCOUNT_STALE",
            error: "Your saved Stripe account is from an old setup. Refresh this page and link your bank again.",
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
