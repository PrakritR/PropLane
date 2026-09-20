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
  removePayoutDestination,
  setDefaultPayoutDestination,
} from "@/lib/stripe-external-accounts.server";

export const runtime = "nodejs";

async function resolveManagerBankEditContext() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, status: 401 as const, error: "Unauthorized." };

  const service = createSupabaseServiceRoleClient();
  const payout = await resolveStripePayoutContext(service, user.id);
  if (!payout.payoutOwnerUserId) {
    return {
      ok: false as const,
      status: (payout.unresolvedReason === "ambiguous_owner" ? 409 : 500) as 409 | 500,
      error: stripePayoutContextError(payout.unresolvedReason),
    };
  }
  const access = await assertCoManagerBankAccountAccess(service, user.id, payout.payoutOwnerUserId, "edit");
  if (!access.ok) return { ok: false as const, status: access.status, error: access.error };
  return { ok: true as const, service, ownerUserId: payout.payoutOwnerUserId };
}

/** Sets the given external account as default for currency. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const auth = await resolveManagerBankEditContext();
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { id } = await ctx.params;
    const accountId = await resolveManagerConnectAccountId(auth.service, auth.ownerUserId);
    if (!accountId) return NextResponse.json({ error: "No payout account yet." }, { status: 422 });

    const stripe = getStripe();
    const result = await setDefaultPayoutDestination(stripe, accountId, id);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

    await refreshPayoutDestinationsCacheFromStripe(stripe, auth.service, auth.ownerUserId, accountId);
    return NextResponse.json({ destination: result.destination });
  } catch (e) {
    return stripePayoutErrorResponse("stripe/connect/bank-accounts/[id] PATCH", e);
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const auth = await resolveManagerBankEditContext();
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { id } = await ctx.params;
    const accountId = await resolveManagerConnectAccountId(auth.service, auth.ownerUserId);
    if (!accountId) return NextResponse.json({ error: "No payout account yet." }, { status: 422 });

    const stripe = getStripe();
    const result = await removePayoutDestination(stripe, auth.service, accountId, id);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

    await refreshPayoutDestinationsCacheFromStripe(stripe, auth.service, auth.ownerUserId, accountId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return stripePayoutErrorResponse("stripe/connect/bank-accounts/[id] DELETE", e);
  }
}
