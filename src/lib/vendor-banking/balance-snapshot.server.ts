import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getStripe } from "@/lib/stripe";
import { resolveManagerConnectAccountId } from "@/lib/stripe-connect";
import { readPayoutSnapshot, snapshotWithPlatformHolds, type PayoutSnapshot } from "@/lib/stripe-payouts.server";
import { readVendorFrozenDisputeCents } from "@/lib/vendor-banking/disputes.server";
import { vendorBankingEnabled } from "@/lib/vendor-banking/flag";

/**
 * The vendor's balance snapshot, read the way `GET /api/vendor/payouts/balance` reads it, for
 * server callers that want to degrade rather than fail (Finances > Overview). It THROWS when
 * Stripe or the connected account cannot answer; the caller decides what to show instead.
 * Money frozen by an open dispute leaves Available, exactly as on the balance route.
 */
export async function readVendorBalanceSnapshot(
  db: SupabaseClient,
  vendorUserId: string,
): Promise<PayoutSnapshot & { frozenDisputeCents?: number }> {
  const accountId = await resolveManagerConnectAccountId(db, vendorUserId);
  const base = accountId
    ? await readPayoutSnapshot(getStripe(), db, { accountId, ownerUserId: vendorUserId, portal: "vendor" })
    : await snapshotWithPlatformHolds(db, vendorUserId);
  if (!vendorBankingEnabled()) return base;
  const frozenDisputeCents = await readVendorFrozenDisputeCents(db, vendorUserId);
  if (frozenDisputeCents <= 0) return { ...base, frozenDisputeCents: 0 };
  return {
    ...base,
    frozenDisputeCents,
    availableCents: Math.max(0, base.availableCents - frozenDisputeCents),
    instantAvailableCents: Math.max(0, base.instantAvailableCents - frozenDisputeCents),
  };
}
