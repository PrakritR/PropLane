import { NextResponse } from "next/server";
import { requireVendorApiAccess } from "@/lib/auth/vendor-api-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripe";
import { resolveManagerConnectAccountId } from "@/lib/stripe-connect";
import { stripePayoutErrorResponse } from "@/lib/stripe-payouts.server";
import { createFinancialConnectionsSession } from "@/lib/stripe-external-accounts.server";
import { stripePublishableKey } from "@/lib/stripe/stripe-js-client";

export const runtime = "nodejs";

export async function POST() {
  try {
    const access = await requireVendorApiAccess();
    if (!access.ok) {
      return NextResponse.json({ error: access.status === 401 ? "Unauthorized." : "Forbidden." }, { status: access.status });
    }

    const db = createSupabaseServiceRoleClient();
    const accountId = await resolveManagerConnectAccountId(db, access.actor.userId);
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
    return stripePayoutErrorResponse("vendor/stripe-connect/financial-connections/session POST", e);
  }
}
