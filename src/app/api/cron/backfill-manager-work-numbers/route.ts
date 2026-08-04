import { NextResponse } from "next/server";
import { backfillManagerWorkNumbers } from "@/lib/backfill-manager-work-numbers.server";
import { sweepSuspendedManagerNumbers } from "@/lib/sms/manager-number-suspension.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Daily sweep: provision up to 10 manager work numbers (idempotent), then
 * advance the 90-day suspended-number grace (warn / release).
 */
export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const db = createSupabaseServiceRoleClient();
  const result = await backfillManagerWorkNumbers(db, { limit: 10 });
  const suspension = await sweepSuspendedManagerNumbers(db, { limit: 50 });
  return NextResponse.json({ ok: true, ...result, suspension });
}
