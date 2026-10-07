import { NextResponse } from "next/server";
import { requireVendorApiAccess } from "@/lib/auth/vendor-api-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripe";
import { isStripeConnectAccountAccessError, resolveManagerConnectAccountId } from "@/lib/stripe-connect";
import { readPayoutSnapshot, snapshotWithPlatformHolds, stripePayoutErrorResponse } from "@/lib/stripe-payouts.server";
import { vendorBankingEnabled, vendorRefundsEnabled } from "@/lib/vendor-banking/flag";
import { vendorPayFeeBps } from "@/lib/platform-fees";
import { readVendorFrozenDisputeCents } from "@/lib/vendor-banking/disputes.server";
import type { PayoutSnapshot } from "@/lib/stripe-payouts.server";

/**
 * Money frozen by an open dispute leaves Available and the withdrawable figure; the finances
 * derivation shows it under Held as "Disputed". `frozenDisputeCents` rides along so the client
 * derives from the same number the withdraw route enforces.
 */
async function withFrozenDisputes(db: ReturnType<typeof createSupabaseServiceRoleClient>, vendorUserId: string, snapshot: PayoutSnapshot) {
  if (!vendorBankingEnabled()) return snapshot;
  const frozenDisputeCents = await readVendorFrozenDisputeCents(db, vendorUserId);
  if (frozenDisputeCents <= 0) return { ...snapshot, frozenDisputeCents: 0 };
  return {
    ...snapshot,
    frozenDisputeCents,
    availableCents: Math.max(0, snapshot.availableCents - frozenDisputeCents),
    instantAvailableCents: Math.max(0, snapshot.instantAvailableCents - frozenDisputeCents),
  };
}

/**
 * Additive: the vendor pay fee rate (0 with the flag off) and whether the refund
 * path is live. The Payments tab shows a row's Refund only when `refundsEnabled`
 * is true — the server flag reaches the client through this one snapshot.
 */
function vendorBankingExtras() {
  return vendorBankingEnabled() ? { feeBps: vendorPayFeeBps(), refundsEnabled: vendorRefundsEnabled() } : {};
}

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
      return NextResponse.json({ ...(await withFrozenDisputes(db, access.actor.userId, await snapshotWithPlatformHolds(db, access.actor.userId))), ...vendorBankingExtras() });
    }

    try {
      const stripe = getStripe();
      const snapshot = await readPayoutSnapshot(stripe, db, {
        accountId,
        ownerUserId: access.actor.userId,
        portal: "vendor",
      });
      return NextResponse.json({ ...(await withFrozenDisputes(db, access.actor.userId, snapshot)), ...vendorBankingExtras() });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Stripe error";
      if (msg.includes("STRIPE_SECRET_KEY") || msg.includes("Missing STRIPE")) {
        return NextResponse.json({ error: "Payout balances are temporarily unavailable." }, { status: 503 });
      }
      if (isStripeConnectAccountAccessError(msg)) {
        return NextResponse.json({ error: "Reconnect your Stripe account to view payouts.", needsRelink: true }, { status: 409 });
      }
      return stripePayoutErrorResponse("vendor/payouts/balance GET", e);
    }
  } catch (e) {
    return stripePayoutErrorResponse("vendor/payouts/balance GET", e);
  }
}
