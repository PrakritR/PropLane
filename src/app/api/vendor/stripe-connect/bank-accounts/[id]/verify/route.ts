import { NextResponse } from "next/server";
import { requireVendorApiAccess } from "@/lib/auth/vendor-api-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripe";
import { resolveManagerConnectAccountId } from "@/lib/stripe-connect";
import { stripePayoutErrorResponse } from "@/lib/stripe-payouts.server";
import {
  refreshPayoutDestinationsCacheFromStripe,
  validateVerifyMicroDepositsRequestBody,
  verifyPayoutDestinationMicroDeposits,
} from "@/lib/stripe-external-accounts.server";

export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const access = await requireVendorApiAccess();
    if (!access.ok) {
      return NextResponse.json({ error: access.status === 401 ? "Unauthorized." : "Forbidden." }, { status: access.status });
    }

    const body = await req.json().catch(() => null);
    const validated = validateVerifyMicroDepositsRequestBody(body);
    if (!validated.ok) return NextResponse.json({ error: validated.error }, { status: 422 });

    const { id } = await ctx.params;
    const db = createSupabaseServiceRoleClient();
    const accountId = await resolveManagerConnectAccountId(db, access.actor.userId);
    if (!accountId) return NextResponse.json({ error: "No payout account yet." }, { status: 422 });

    const stripe = getStripe();
    const result = await verifyPayoutDestinationMicroDeposits(stripe, accountId, id, validated.input.amounts);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

    await refreshPayoutDestinationsCacheFromStripe(stripe, db, access.actor.userId, accountId);
    return NextResponse.json({ destination: result.destination });
  } catch (e) {
    return stripePayoutErrorResponse("vendor/stripe-connect/bank-accounts/[id]/verify POST", e);
  }
}
