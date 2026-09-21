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
import { isStripeConnectAccountAccessError } from "@/lib/stripe-connect";
import { createAccountSession, isEmbeddedComponent } from "@/lib/stripe-connect-embedded";
import { stripePayoutErrorResponse } from "@/lib/stripe-payouts.server";

export const runtime = "nodejs";

/**
 * Creates a Stripe Account Session for exactly one embedded component, so the
 * client can mount Stripe's onboarding/management UI inside PropLane's own
 * modal chrome. Replaces Account Links and Express Dashboard login links —
 * see PLAN-0920-0853.
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

    const body = await req.json().catch(() => null);
    const component = (body as { component?: unknown } | null)?.component;
    if (!isEmbeddedComponent(component)) {
      return NextResponse.json({ error: "Invalid component." }, { status: 400 });
    }

    const service = createSupabaseServiceRoleClient();
    const payout = await resolveStripePayoutContext(service, user.id);
    if (!payout.payoutOwnerUserId) {
      return NextResponse.json(
        { error: stripePayoutContextError(payout.unresolvedReason) },
        { status: payout.unresolvedReason === "ambiguous_owner" ? 409 : 500 },
      );
    }

    // `notification_banner` is read-only; onboarding/management mutate bank
    // details and therefore need the edit-level co-manager grant.
    const level = component === "notification_banner" ? "read" : "edit";
    const access = await assertCoManagerBankAccountAccess(service, user.id, payout.payoutOwnerUserId, level);
    if (!access.ok) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }

    try {
      const stripe = getStripe();
      const { data: ownerProfile } = await service
        .from("profiles")
        .select("email")
        .eq("id", payout.payoutOwnerUserId)
        .maybeSingle();
      const accountId = await ensureManagerConnectAccountId(stripe, service, {
        userId: payout.payoutOwnerUserId,
        email: ownerProfile?.email ?? user.email ?? undefined,
        allowClearStale: false,
      });

      const session = await createAccountSession(stripe, accountId, component);
      return NextResponse.json(session);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Stripe error";
      if (msg.includes("STRIPE_SECRET_KEY") || msg.includes("Missing STRIPE")) {
        return NextResponse.json({
          demo: true,
          message:
            "Stripe is not configured (missing STRIPE_SECRET_KEY). Add keys in your environment to enable live embedded payout setup.",
        });
      }
      if (isStripeConnectAccountAccessError(msg)) {
        return NextResponse.json(
          {
            code: "CONNECT_ACCOUNT_NEEDS_RELINK",
            needsRelink: true,
            error: "We couldn't reach your saved Stripe account. Reconnect to start over.",
          },
          { status: 409 },
        );
      }
      return stripePayoutErrorResponse("stripe/connect/account-session POST", e);
    }
  } catch (e) {
    return stripePayoutErrorResponse("stripe/connect/account-session POST", e);
  }
}
