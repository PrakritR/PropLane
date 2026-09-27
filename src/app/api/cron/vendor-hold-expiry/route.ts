import { NextResponse } from "next/server";
import { isProductionRuntime } from "@/lib/server-env";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripe";
import { vendorBankingEnabled } from "@/lib/vendor-banking/flag";
import { expireVendorHolds } from "@/lib/vendor-banking/hold-expiry.server";

export const runtime = "nodejs";
export const maxDuration = 120;

function isAuthorized(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) {
    // Same rule as the other money-adjacent crons: secretless access is a
    // localhost convenience only. This one can refund real platform money.
    return !process.env.VERCEL_ENV && !isProductionRuntime();
  }
  return req.headers.get("authorization") === `Bearer ${cronSecret}`;
}

/**
 * VD58 (captain's recommended option): a vendor_invoice-sourced platform
 * hold still unclaimed 90 days after payment is returned to the manager who
 * paid it, with matching ledger lines and a best-effort notice to both
 * parties. A no-op while VENDOR_BANKING_ENABLED is off, so registering this
 * cron is safe before the flag is ever turned on anywhere.
 */
export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!vendorBankingEnabled()) {
    return NextResponse.json({ checked: 0, returned: 0, failed: 0, errors: [], enabled: false });
  }
  const db = createSupabaseServiceRoleClient();
  const stripe = getStripe();
  const result = await expireVendorHolds(stripe, db);
  return NextResponse.json({ ...result, enabled: true });
}
