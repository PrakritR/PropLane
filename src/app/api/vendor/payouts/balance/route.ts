import { NextResponse } from "next/server";
import { requireVendorApiAccess } from "@/lib/auth/vendor-api-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripe";
import { isStripeConnectAccountAccessError, resolveManagerConnectAccountId } from "@/lib/stripe-connect";
import { emptyPayoutSnapshot, readPayoutSnapshot } from "@/lib/stripe-payouts.server";

export const runtime = "nodejs";

/** Vendor twin of `/api/stripe/payouts/balance` — the vendor's own Connect account. */
export async function GET() {
  try {
    const access = await requireVendorApiAccess();
    if (!access.ok) {
      return NextResponse.json(
        { error: access.status === 401 ? "Unauthorized." : "Forbidden." },
        { status: access.status },
      );
    }

    const db = createSupabaseServiceRoleClient();
    const accountId = await resolveManagerConnectAccountId(db, access.actor.userId);
    if (!accountId) {
      return NextResponse.json(emptyPayoutSnapshot());
    }

    try {
      const stripe = getStripe();
      const snapshot = await readPayoutSnapshot(stripe, db, {
        accountId,
        ownerUserId: access.actor.userId,
        portal: "vendor",
      });
      return NextResponse.json(snapshot);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Stripe error";
      if (msg.includes("STRIPE_SECRET_KEY") || msg.includes("Missing STRIPE")) {
        return NextResponse.json({ ...emptyPayoutSnapshot(), demo: true });
      }
      if (isStripeConnectAccountAccessError(msg)) {
        return NextResponse.json({ ...emptyPayoutSnapshot(), needsRelink: true });
      }
      return NextResponse.json({ error: msg }, { status: 400 });
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
