import { NextResponse } from "next/server";
import { reconcileManagerPlans } from "@/lib/billing/reconcile-manager-plans.server";
import { isProductionRuntime } from "@/lib/server-env";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
export const maxDuration = 300;

function isAuthorized(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) {
    // Same rule as the other plan/money crons: secretless access is a localhost convenience only.
    return !process.env.VERCEL_ENV && !isProductionRuntime();
  }
  return req.headers.get("authorization") === `Bearer ${cronSecret}`;
}

/**
 * Daily: every paid `manager_purchases` row re-checked against Stripe (and RevenueCat for an Apple anchor), so a
 * cancellation that no webhook ever landed cannot leave a managed workspace unlocked. The reconcilers downgrade
 * only on a definitive provider answer; a transient failure keeps the stored plan and is reported here.
 */
export async function GET(req: Request) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const result = await reconcileManagerPlans(createSupabaseServiceRoleClient());
  return NextResponse.json({ ok: result.failed === 0, ...result, errors: result.errors.length ? result.errors : undefined });
}
