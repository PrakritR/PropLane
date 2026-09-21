import { NextResponse } from "next/server";
import { assertCoManagerBankAccountAccess } from "@/lib/auth/co-manager-bank-account-access";
import {
  resolveStripePayoutContext,
  stripePayoutContextError,
} from "@/lib/auth/manager-stripe-payout-access.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripe";
import { isStripeConnectAccountAccessError, resolveManagerConnectAccountId } from "@/lib/stripe-connect";
import { emptyPayoutSnapshot, readPayoutSnapshot, stripePayoutErrorResponse } from "@/lib/stripe-payouts.server";

export const runtime = "nodejs";

/** GET the manager's (or, for a co-manager, the payout owner's) Payouts page snapshot. */
export async function GET() {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const service = createSupabaseServiceRoleClient();
    const payout = await resolveStripePayoutContext(service, user.id);
    if (!payout.payoutOwnerUserId) {
      return NextResponse.json(
        { error: stripePayoutContextError(payout.unresolvedReason) },
        { status: payout.unresolvedReason === "ambiguous_owner" ? 409 : 500 },
      );
    }
    // Same read-level gate every other payouts route enforces — a co-manager
    // needs the bank-account grant (at least "read") to see the owner's
    // balance and payout history at all.
    const access = await assertCoManagerBankAccountAccess(service, user.id, payout.payoutOwnerUserId, "read");
    if (!access.ok) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }

    const accountId = await resolveManagerConnectAccountId(service, payout.payoutOwnerUserId);
    if (!accountId) {
      return NextResponse.json(emptyPayoutSnapshot());
    }

    try {
      const stripe = getStripe();
      const snapshot = await readPayoutSnapshot(stripe, service, {
        accountId,
        ownerUserId: payout.payoutOwnerUserId,
        portal: "manager",
      });
      return NextResponse.json(snapshot);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Stripe error";
      if (msg.includes("STRIPE_SECRET_KEY") || msg.includes("Missing STRIPE")) {
        return NextResponse.json({ ...emptyPayoutSnapshot(), demo: true });
      }
      // The saved id stays put; the page offers Reconnect instead of a dead end.
      if (isStripeConnectAccountAccessError(msg)) {
        return NextResponse.json({ ...emptyPayoutSnapshot(), needsRelink: true });
      }
      return stripePayoutErrorResponse("stripe/payouts/balance GET", e);
    }
  } catch (e) {
    return stripePayoutErrorResponse("stripe/payouts/balance GET", e);
  }
}
