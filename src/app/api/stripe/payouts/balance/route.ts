import { NextResponse } from "next/server";
import {
  resolveStripePayoutContext,
  stripePayoutContextError,
} from "@/lib/auth/manager-stripe-payout-access.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripe";
import { resolveManagerConnectAccountId } from "@/lib/stripe-connect";
import { emptyPayoutSnapshot, readPayoutSnapshot } from "@/lib/stripe-payouts.server";

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
      return NextResponse.json({ error: msg }, { status: 400 });
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
