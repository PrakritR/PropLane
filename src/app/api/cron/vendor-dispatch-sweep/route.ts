/**
 * Vendor dispatch scheduler tick (vendor-dispatch-1018): offers past their timeout move to
 * the next vendor, unanswered manager approvals are resent then escalated, stale runs
 * expire, and checkouts at houses with a cleaner rule open a turnover run. Every two
 * minutes, because an emergency offer times out in ten.
 */
import { NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/cron-auth.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { sweepVendorDispatch } from "@/lib/vendor-dispatch/sweep.server";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(req: Request) {
  if (!requireCronSecret(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const now = new Date();
    // The booking scan reads three tables: about every ten minutes is plenty for a checkout that is hours away.
    const turnovers = now.getUTCMinutes() % 10 < 2;
    const summary = await sweepVendorDispatch(createSupabaseServiceRoleClient(), now, { turnovers });
    return NextResponse.json({ ok: summary.errors.length === 0, ...summary });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "sweep failed" }, { status: 500 });
  }
}
