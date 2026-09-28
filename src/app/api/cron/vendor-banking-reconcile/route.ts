import { NextResponse } from "next/server";
import { isProductionRuntime } from "@/lib/server-env";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripe";
import { vendorBankingEnabled } from "@/lib/vendor-banking/flag";
import { reconcileAllVendorBankingLedgers } from "@/lib/vendor-banking/reconcile.server";

export const runtime = "nodejs";
export const maxDuration = 120;

function isAuthorized(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) {
    return !process.env.VERCEL_ENV && !isProductionRuntime();
  }
  return req.headers.get("authorization") === `Bearer ${cronSecret}`;
}

/**
 * Nightly: compares every vendor's banking ledger running total against
 * their real Stripe connected-account balance (plus any still-held cents),
 * stamping the "Matches Stripe · last checked …" reconciliation row the
 * Statement modal reads. Never auto-corrects — a drift is reported, not
 * silently fixed. A no-op while VENDOR_BANKING_ENABLED is off.
 */
export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!vendorBankingEnabled()) {
    return NextResponse.json({ checked: 0, matched: 0, drifted: 0, drifts: [], enabled: false });
  }
  const db = createSupabaseServiceRoleClient();
  const stripe = getStripe();
  const result = await reconcileAllVendorBankingLedgers(stripe, db);
  return NextResponse.json({ ...result, enabled: true });
}
