import { NextResponse } from "next/server";
import { isProductionRuntime } from "@/lib/server-env";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripe";
import { reconcilePlatformLedgerCharges } from "@/lib/proplane-balance/reconcile.server";
import { reconcileReservedPlatformOwnerRecovery, reconcileUnhydratedCentralSourceMirrors } from "@/lib/platform-owner-recovery.server";
import { reconcileReservedPlatformHoldTransfers } from "@/lib/platform-hold-release.server";
import { reconcileClassifiedBalanceWithdrawals } from "@/lib/proplane-balance/withdraw-reconcile.server";

export const runtime = "nodejs";
export const maxDuration = 300;

function isAuthorized(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) {
    // Same rule as run-autopay/comms-billing-invoice: preview deployments are
    // public and hold real credentials, so secretless access is a localhost
    // convenience only. This one can credit real platform money, so it fails
    // closed everywhere else.
    return !process.env.VERCEL_ENV && !isProductionRuntime();
  }
  return req.headers.get("authorization") === `Bearer ${cronSecret}`;
}

/**
 * Backstop for the best-effort webhook credit in
 * `household-charge-credit.server.ts`: a failed credit there leaves real
 * platform money with no `proplane_balance_entries` row at all. This finds
 * every succeeded `platform_ledger` PaymentIntent from the last 7 days whose
 * charge has no matching ledger entry and credits it — idempotently, via the
 * SAME `resident-payment:<checkout session id>` key the webhook uses, so a
 * late webhook redelivery and this cron can never double-credit each other,
 * and running this twice in a row is a no-op the second time.
 *
 * A no-op entirely while `PROPLANE_BALANCE_ENABLED` is off (see
 * `reconcilePlatformLedgerCharges`) — registering this cron is safe before
 * the flag is ever turned on anywhere.
 */
export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = createSupabaseServiceRoleClient();
  const stripe = getStripe();
  const result = await reconcilePlatformLedgerCharges(stripe, db);
  const ownerRecovery = await reconcileReservedPlatformOwnerRecovery(db, stripe);
  const centralAvailability = await reconcileUnhydratedCentralSourceMirrors(db, stripe);
  const holdTransfers = await reconcileReservedPlatformHoldTransfers(db, stripe);
  const withdrawals = await reconcileClassifiedBalanceWithdrawals(stripe, db);
  return NextResponse.json({ ...result, ownerRecovery, centralAvailability, holdTransfers, withdrawals });
}
