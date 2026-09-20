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
import { stripePayoutErrorResponse, writePayoutSchedule } from "@/lib/stripe-payouts.server";
import { validateScheduleRequestBody } from "@/lib/stripe-payouts";

export const runtime = "nodejs";

/** Writes the payout schedule on the manager's Connect account and reads it back. */
export async function PUT(req: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const body = await req.json().catch(() => null);
    const validated = validateScheduleRequestBody(body);
    if (!validated.ok) {
      return NextResponse.json({ error: validated.error }, { status: 422 });
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

    const accountId = await resolveManagerConnectAccountId(service, payout.payoutOwnerUserId);
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
      return stripePayoutErrorResponse("stripe/payouts/schedule PUT", e);
    }
  } catch (e) {
    return stripePayoutErrorResponse("stripe/payouts/schedule PUT", e);
  }
}
