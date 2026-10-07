import { NextResponse } from "next/server";
import { requireVendorApiAccess } from "@/lib/auth/vendor-api-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripe";
import { resolveManagerConnectAccountId } from "@/lib/stripe-connect";
import { createInAppPayout, stripePayoutErrorResponse } from "@/lib/stripe-payouts.server";
import { validateCreatePayoutRequestBody, type PayoutMethod } from "@/lib/stripe-payouts";
import { vendorBankingEnabled } from "@/lib/vendor-banking/flag";
import { vendorInstantWithdrawFeeCents } from "@/lib/platform-fees";
import { recordVendorWithdrawalLedger } from "@/lib/vendor-banking/withdrawal-ledger.server";

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
        // VD-studio ground truth (payout-withdraw-sheet.tsx): vendor Instant
        // withdrawals carry PropLane's own 1.5% fee (min $0.50), distinct
        // from the shared 1% Stripe-cost fee every other Instant payout
        // uses. 0 with the flag off falls through to the shared rate.
        computeFeeCents: vendorBankingEnabled()
          ? (method: PayoutMethod, amountCents: number) =>
              method === "instant" ? vendorInstantWithdrawFeeCents(amountCents) : 0
          : undefined,
      });
      if (!result.ok) {
        return NextResponse.json({ error: result.error }, { status: result.status });
      }
      const { payoutId, amountCents, feeCents, netCents, arrivalDate, method } = result;
      if (vendorBankingEnabled()) {
        try {
          await recordVendorWithdrawalLedger(db, {
            vendorUserId: access.actor.userId,
            payoutId,
            amountCents,
            feeCents,
            method,
          });
        } catch (ledgerError) {
          // The withdrawal already happened; never turn it into an error response.
          console.error("[vendor/payouts/create] withdrawal ledger write failed", ledgerError instanceof Error ? ledgerError.message : ledgerError);
        }
      }
      return NextResponse.json({ payoutId, amountCents, feeCents, netCents, arrivalDate, method });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Stripe error";
      if (msg.includes("STRIPE_SECRET_KEY") || msg.includes("Missing STRIPE")) {
        return NextResponse.json(
          { code: "STRIPE_NOT_CONFIGURED", error: "Stripe is not configured (missing STRIPE_SECRET_KEY)." },
          { status: 503 },
        );
      }
      return stripePayoutErrorResponse("vendor/payouts/create POST", e);
    }
  } catch (e) {
    return stripePayoutErrorResponse("vendor/payouts/create POST", e);
  }
}
