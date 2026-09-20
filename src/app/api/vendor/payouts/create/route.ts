import { NextResponse } from "next/server";
import { requireVendorApiAccess } from "@/lib/auth/vendor-api-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripe";
import { resolveManagerConnectAccountId } from "@/lib/stripe-connect";
import { createInAppPayout } from "@/lib/stripe-payouts.server";
import { validateCreatePayoutRequestBody } from "@/lib/stripe-payouts";

export const runtime = "nodejs";

/** Vendor twin of `/api/stripe/payouts/create` — pays out from the vendor's own Connect balance. */
export async function POST(req: Request) {
  try {
    const access = await requireVendorApiAccess();
    if (!access.ok) {
      return NextResponse.json(
        { error: access.status === 401 ? "Unauthorized." : "Forbidden." },
        { status: access.status },
      );
    }

    const body = await req.json().catch(() => null);
    const validated = validateCreatePayoutRequestBody(body);
    if (!validated.ok) {
      return NextResponse.json({ error: validated.error }, { status: 422 });
    }

    const db = createSupabaseServiceRoleClient();
    const accountId = await resolveManagerConnectAccountId(db, access.actor.userId);
    if (!accountId) {
      return NextResponse.json({ error: "Finish setting up payouts before paying out." }, { status: 422 });
    }

    try {
      const stripe = getStripe();
      const result = await createInAppPayout(stripe, db, {
        accountId,
        ownerUserId: access.actor.userId,
        vendorUserId: access.actor.userId,
        input: validated.input,
      });
      if (!result.ok) {
        return NextResponse.json({ error: result.error }, { status: result.status });
      }
      const { payoutId, amountCents, feeCents, netCents, arrivalDate, method } = result;
      return NextResponse.json({ payoutId, amountCents, feeCents, netCents, arrivalDate, method });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Stripe error";
      if (msg.includes("STRIPE_SECRET_KEY") || msg.includes("Missing STRIPE")) {
        return NextResponse.json(
          { code: "STRIPE_NOT_CONFIGURED", error: "Stripe is not configured (missing STRIPE_SECRET_KEY)." },
          { status: 503 },
        );
      }
      return NextResponse.json({ error: msg }, { status: 400 });
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
