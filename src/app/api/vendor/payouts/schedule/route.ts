import { NextResponse } from "next/server";
import { requireVendorApiAccess } from "@/lib/auth/vendor-api-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripe";
import { resolveManagerConnectAccountId } from "@/lib/stripe-connect";
import { stripePayoutErrorResponse, writePayoutSchedule } from "@/lib/stripe-payouts.server";
import { validateScheduleRequestBody } from "@/lib/stripe-payouts";

export const runtime = "nodejs";

/** Vendor twin of `/api/stripe/payouts/schedule`. */
export async function PUT(req: Request) {
  try {
    const access = await requireVendorApiAccess();
    if (!access.ok) {
      return NextResponse.json(
        { error: access.status === 401 ? "Unauthorized." : "Forbidden." },
        { status: access.status },
      );
    }

    const body = await req.json().catch(() => null);
    const validated = validateScheduleRequestBody(body);
    if (!validated.ok) {
      return NextResponse.json({ error: validated.error }, { status: 422 });
    }

    const db = createSupabaseServiceRoleClient();
    const accountId = await resolveManagerConnectAccountId(db, access.actor.userId);
    if (!accountId) {
      return NextResponse.json({ error: "Finish setting up payouts before changing the schedule." }, { status: 422 });
    }

    try {
      const stripe = getStripe();
      const schedule = await writePayoutSchedule(stripe, { accountId, schedule: validated.schedule });
      return NextResponse.json(schedule);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Stripe error";
      if (msg.includes("STRIPE_SECRET_KEY") || msg.includes("Missing STRIPE")) {
        return NextResponse.json(
          { code: "STRIPE_NOT_CONFIGURED", error: "Stripe is not configured (missing STRIPE_SECRET_KEY)." },
          { status: 503 },
        );
      }
      return stripePayoutErrorResponse("vendor/payouts/schedule PUT", e);
    }
  } catch (e) {
    return stripePayoutErrorResponse("vendor/payouts/schedule PUT", e);
  }
}
