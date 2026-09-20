import { NextResponse } from "next/server";
import { assertCoManagerBankAccountAccess } from "@/lib/auth/co-manager-bank-account-access";
import {
  resolveStripePayoutContext,
  stripePayoutContextError,
} from "@/lib/auth/manager-stripe-payout-access.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripe";
import { ensureManagerConnectAccountId } from "@/lib/stripe-connect-account";
import {
  connectAccountReadyForAchPayouts,
  connectAccountTransfersActive,
  ensureConnectAccountTransfersRequested,
  isStripeConnectAccountAccessError,
  clearManagerConnectAccountId,
} from "@/lib/stripe-connect";

export const runtime = "nodejs";

/**
 * Ensures a Connect account exists for the signed-in user (creating one if
 * needed) and reports its readiness. PLAN-0920-0853 replaces the redirect to
 * Stripe (Account Links) and the Express Dashboard login link with embedded
 * onboarding — the client mounts `account_onboarding` via
 * `/api/stripe/connect/account-session` in PropLane's own modal, so this
 * route no longer mints or returns any Stripe-hosted URL.
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

    const service = createSupabaseServiceRoleClient();
    const payout = await resolveStripePayoutContext(service, user.id);
    if (!payout.payoutOwnerUserId) {
      return NextResponse.json(
        { error: stripePayoutContextError(payout.unresolvedReason) },
        { status: payout.unresolvedReason === "ambiguous_owner" ? 409 : 500 },
      );
    }
    const access = await assertCoManagerBankAccountAccess(service, user.id, payout.payoutOwnerUserId, "edit");
    if (!access.ok) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }

    const payoutOwnerId = payout.payoutOwnerUserId;
    const { data: ownerProfile } = await service
      .from("profiles")
      .select("email")
      .eq("id", payoutOwnerId)
      .maybeSingle();

    try {
      const stripe = getStripe();
      const accountId = await ensureManagerConnectAccountId(stripe, service, {
        userId: payoutOwnerId,
        email: ownerProfile?.email ?? user.email ?? undefined,
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
      // Reset-and-relink: a stale saved account id (e.g. from an old Stripe
      // setup the platform key can no longer access) is cleared so the next
      // attempt creates a fresh account instead of retrying the same dead id.
      if (isStripeConnectAccountAccessError(msg)) {
        await clearManagerConnectAccountId(service, payoutOwnerId).catch(() => undefined);
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
