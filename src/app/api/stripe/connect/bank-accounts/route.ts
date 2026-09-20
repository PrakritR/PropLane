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
  addPayoutDestination,
  refreshPayoutDestinationsCacheFromStripe,
  validateAddBankAccountRequestBody,
} from "@/lib/stripe-external-accounts.server";

export const runtime = "nodejs";

type ManagerBankContext =
  | { ok: true; service: ReturnType<typeof createSupabaseServiceRoleClient>; ownerUserId: string }
  | { ok: false; status: 401 | 403 | 409 | 500; error: string };

/** Re-derives the owner and co-manager bank-edit permission from the session — never a client-supplied id. */
async function resolveManagerBankContext(level: "read" | "edit"): Promise<ManagerBankContext> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, status: 401, error: "Unauthorized." };

  const service = createSupabaseServiceRoleClient();
  const payout = await resolveStripePayoutContext(service, user.id);
  if (!payout.payoutOwnerUserId) {
    return {
      ok: false,
      status: payout.unresolvedReason === "ambiguous_owner" ? 409 : 500,
      error: stripePayoutContextError(payout.unresolvedReason),
    };
  }
  const access = await assertCoManagerBankAccountAccess(service, user.id, payout.payoutOwnerUserId, level);
  if (!access.ok) return { ok: false, status: access.status, error: access.error };
  return { ok: true, service, ownerUserId: payout.payoutOwnerUserId };
}

export async function GET() {
  try {
    const ctx = await resolveManagerBankContext("read");
    if (!ctx.ok) return NextResponse.json({ error: ctx.error }, { status: ctx.status });

    const accountId = await resolveManagerConnectAccountId(ctx.service, ctx.ownerUserId);
    if (!accountId) return NextResponse.json({ destinations: [] });

    const stripe = getStripe();
    const destinations = await refreshPayoutDestinationsCacheFromStripe(stripe, ctx.service, ctx.ownerUserId, accountId);
    return NextResponse.json({ destinations });
  } catch (e) {
    return stripePayoutErrorResponse("stripe/connect/bank-accounts GET", e);
  }
}

export async function POST(req: Request) {
  try {
    const ctx = await resolveManagerBankContext("edit");
    if (!ctx.ok) return NextResponse.json({ error: ctx.error }, { status: ctx.status });

    const body = await req.json().catch(() => null);
    const validated = validateAddBankAccountRequestBody(body);
    if (!validated.ok) return NextResponse.json({ error: validated.error }, { status: 422 });

    const accountId = await resolveManagerConnectAccountId(ctx.service, ctx.ownerUserId);
    if (!accountId) {
      return NextResponse.json({ error: "Finish setting up payouts before adding a bank account." }, { status: 422 });
    }

    const stripe = getStripe();
    const result = await addPayoutDestination(stripe, accountId, validated.input);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

    await refreshPayoutDestinationsCacheFromStripe(stripe, ctx.service, ctx.ownerUserId, accountId);
    return NextResponse.json({ destination: result.destination });
  } catch (e) {
    return stripePayoutErrorResponse("stripe/connect/bank-accounts POST", e);
  }
}
