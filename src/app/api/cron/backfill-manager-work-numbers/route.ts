import { requireCronSecret } from "@/lib/cron-auth.server";
import { NextResponse } from "next/server";
import { backfillManagerWorkNumbers } from "@/lib/backfill-manager-work-numbers.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Daily sweep: provision up to 10 manager work numbers per run (idempotent).
 *
 * Gated by the shared cron rule (`requireCronSecret`): an ABSENT `CRON_SECRET`
 * authorizes only a localhost/test run, never a deployment. This is the most
 * expensive route to leave open — each call PURCHASES up to 10 Twilio numbers
 * with recurring monthly cost, and it is repeatable.
 */
export async function GET(req: Request) {
  if (!requireCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const db = createSupabaseServiceRoleClient();
  // Inventory only. Number purchases are explicit owner actions in Settings;
  // a scheduled job must never create recurring Twilio spend.
  const result = await backfillManagerWorkNumbers(db, { limit: 10, dryRun: true });
  // Counts only. `result.numbers` pairs each manager id with their provisioned
  // work number — operator detail that a response body has no reason to carry,
  // and which this route used to hand back to whoever called it.
  return NextResponse.json({
    ok: true,
    dryRun: result.dryRun,
    considered: result.considered,
    provisioned: result.provisioned,
    failed: result.failed,
  });
}
