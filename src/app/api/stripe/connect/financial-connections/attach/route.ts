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
  addFromFinancialConnections,
  refreshPayoutDestinationsCacheFromStripe,
  validateFinancialConnectionsAttachRequestBody,
} from "@/lib/stripe-external-accounts.server";

export const runtime = "nodejs";

/** Finishes "Link instantly": turns the account the manager just picked in the Financial Connections modal into a payout destination. */
export async function POST(req: Request) {
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
    const validated = validateFinancialConnectionsAttachRequestBody(body);
    if (!validated.ok) return NextResponse.json({ error: validated.error }, { status: 422 });

    const accountId = await resolveManagerConnectAccountId(service, payout.payoutOwnerUserId);
    if (!accountId) {
      return NextResponse.json({ error: "Finish setting up payouts before adding a bank account." }, { status: 422 });
    }

    const stripe = getStripe();
    const result = await addFromFinancialConnections(stripe, accountId, validated.input);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

    await refreshPayoutDestinationsCacheFromStripe(stripe, service, payout.payoutOwnerUserId, accountId);
    return NextResponse.json({ destination: result.destination });
  } catch (e) {
    return stripePayoutErrorResponse("stripe/connect/financial-connections/attach POST", e);
  }
}
