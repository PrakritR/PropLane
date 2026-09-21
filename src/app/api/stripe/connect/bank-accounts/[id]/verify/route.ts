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
import {
  refreshPayoutDestinationsCacheFromStripe,
  validateVerifyMicroDepositsRequestBody,
  verifyPayoutDestinationMicroDeposits,
} from "@/lib/stripe-external-accounts.server";

export const runtime = "nodejs";

/** Confirms the two small test deposits Stripe sent for a manually-added bank account. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
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

    const body = await req.json().catch(() => null);
    const validated = validateVerifyMicroDepositsRequestBody(body);
    if (!validated.ok) return NextResponse.json({ error: validated.error }, { status: 422 });

    const { id } = await ctx.params;
    const accountId = await resolveManagerConnectAccountId(service, payout.payoutOwnerUserId);
    if (!accountId) return NextResponse.json({ error: "No payout account yet." }, { status: 422 });

    const stripe = getStripe();
    const result = await verifyPayoutDestinationMicroDeposits(stripe, accountId, id, validated.input.amounts);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

    await refreshPayoutDestinationsCacheFromStripe(stripe, service, payout.payoutOwnerUserId, accountId);
    return NextResponse.json({ destination: result.destination });
  } catch (e) {
    return stripePayoutErrorResponse("stripe/connect/bank-accounts/[id]/verify POST", e);
  }
}
