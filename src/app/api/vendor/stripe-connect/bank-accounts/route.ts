import { NextResponse } from "next/server";
import { requireVendorApiAccess } from "@/lib/auth/vendor-api-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripe";
import { resolveManagerConnectAccountId } from "@/lib/stripe-connect";
import { stripePayoutErrorResponse } from "@/lib/stripe-payouts.server";
import {
  addPayoutDestination,
  refreshPayoutDestinationsCacheFromStripe,
  validateAddBankAccountRequestBody,
} from "@/lib/stripe-external-accounts.server";

export const runtime = "nodejs";

/** Vendor twin of `/api/stripe/connect/bank-accounts` — a vendor never sees another vendor's or a manager's accounts. */
export async function GET() {
  try {
    const access = await requireVendorApiAccess();
    if (!access.ok) {
      return NextResponse.json({ error: access.status === 401 ? "Unauthorized." : "Forbidden." }, { status: access.status });
    }

    const db = createSupabaseServiceRoleClient();
    const accountId = await resolveManagerConnectAccountId(db, access.actor.userId);
    if (!accountId) return NextResponse.json({ destinations: [] });

    const stripe = getStripe();
    const destinations = await refreshPayoutDestinationsCacheFromStripe(stripe, db, access.actor.userId, accountId);
    return NextResponse.json({ destinations });
  } catch (e) {
    return stripePayoutErrorResponse("vendor/stripe-connect/bank-accounts GET", e);
  }
}

export async function POST(req: Request) {
  try {
    const access = await requireVendorApiAccess();
    if (!access.ok) {
      return NextResponse.json({ error: access.status === 401 ? "Unauthorized." : "Forbidden." }, { status: access.status });
    }

    const body = await req.json().catch(() => null);
    const validated = validateAddBankAccountRequestBody(body);
    if (!validated.ok) return NextResponse.json({ error: validated.error }, { status: 422 });

    const db = createSupabaseServiceRoleClient();
    const accountId = await resolveManagerConnectAccountId(db, access.actor.userId);
    if (!accountId) {
      return NextResponse.json({ error: "Finish setting up payouts before adding a bank account." }, { status: 422 });
    }

    const stripe = getStripe();
    const result = await addPayoutDestination(stripe, accountId, validated.input);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

    await refreshPayoutDestinationsCacheFromStripe(stripe, db, access.actor.userId, accountId);
    return NextResponse.json({ destination: result.destination });
  } catch (e) {
    return stripePayoutErrorResponse("vendor/stripe-connect/bank-accounts POST", e);
  }
}
