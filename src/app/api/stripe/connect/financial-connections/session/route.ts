import { NextResponse } from "next/server";
import { assertCoManagerBankAccountAccess } from "@/lib/auth/co-manager-bank-account-access";
import {
  resolveStripePayoutContext,
  stripePayoutContextError,
} from "@/lib/auth/manager-stripe-payout-access.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripe";
import { resolveManagerConnectAccountId } from "@/lib/stripe-connect";
import { stripePayoutErrorResponse } from "@/lib/stripe-payouts.server";
import { createFinancialConnectionsSession } from "@/lib/stripe-external-accounts.server";
import { stripePublishableKey } from "@/lib/stripe/stripe-js-client";

export const runtime = "nodejs";

/** Starts the "Link instantly" flow — a Financial Connections Session client secret for the manager's own connected account. */
export async function POST() {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const service = createSupabaseServiceRoleClient();
    const payout = await resolveStripePayoutContext(service, user.id);
    if (!payout.payoutOwnerUserId) {
      return NextResponse.json(
        { error: stripePayoutContextError(payout.unresolvedReason) },
        { status: payout.unresolvedReason === "ambiguous_owner" ? 409 : 500 },
      );
    }
    const access = await assertCoManagerBankAccountAccess(service, user.id, payout.payoutOwnerUserId, "edit");
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

    const accountId = await resolveManagerConnectAccountId(service, payout.payoutOwnerUserId);
    if (!accountId) {
      return NextResponse.json({ error: "Finish setting up payouts before adding a bank account." }, { status: 422 });
    }

    const publishableKey = stripePublishableKey();
    if (!publishableKey) {
      return NextResponse.json(
        { code: "STRIPE_NOT_CONFIGURED", error: "Stripe is not configured (missing NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY)." },
        { status: 503 },
      );
    }

    const stripe = getStripe();
    const session = await createFinancialConnectionsSession(stripe, accountId);
    return NextResponse.json({ clientSecret: session.clientSecret, publishableKey });
  } catch (e) {
    return stripePayoutErrorResponse("stripe/connect/financial-connections/session POST", e);
  }
}
