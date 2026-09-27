import { NextResponse } from "next/server";
import { assertVendorFinancialsAccess, getReportsAuthContext } from "@/lib/reports/auth";
import { proplaneBalanceEnabled } from "@/lib/proplane-balance/flag";
import { withdrawFromBalance } from "@/lib/proplane-balance/withdraw.server";
import { getStripe } from "@/lib/stripe";
import { stripePayoutErrorResponse } from "@/lib/stripe-payouts.server";
import { track } from "@/lib/analytics/posthog";

export const runtime = "nodejs";

/** Vendor withdraws from their PropLane balance to their own connected bank. */
export async function POST(req: Request) {
  try {
    if (!proplaneBalanceEnabled()) {
      return NextResponse.json({ error: "The PropLane balance is not enabled." }, { status: 404 });
    }
    const auth = await getReportsAuthContext({ preferRole: "vendor" });
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const gate = await assertVendorFinancialsAccess(auth);
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

    const body = (await req.json().catch(() => ({}))) as { amountCents?: unknown };
    const amountCents = Math.round(Number(body.amountCents));
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      return NextResponse.json({ error: "amountCents must be a positive number." }, { status: 400 });
    }

    const stripe = getStripe();
    const result = await withdrawFromBalance(stripe, auth.db, {
      ownerKind: "vendor",
      ownerUserId: auth.userId,
      amountCents,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

    track("proplane_balance_withdrawal", auth.userId, {
      amount_cents: amountCents,
      payout_pending: result.payoutPending,
    });
    return NextResponse.json(result);
  } catch (e) {
    return stripePayoutErrorResponse("vendor/proplane-balance/withdraw", e);
  }
}
