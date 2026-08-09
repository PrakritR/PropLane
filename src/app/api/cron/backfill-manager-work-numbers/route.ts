import { NextResponse } from "next/server";
import { backfillManagerWorkNumbers } from "@/lib/backfill-manager-work-numbers.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { isProductionRuntime } from "@/lib/server-env";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Daily sweep: provision up to 10 manager work numbers per run (idempotent). */
// Same shape as every other cron route (see send-payment-reminders,
// sms-pool-topup, …): an ABSENT secret authorizes only outside production.
// This route previously used `if (cronSecret && …)`, so an unset secret skipped
// the check entirely — in production too. It was the only one of the nine
// without the fallback, and it is the most expensive one to leave open: each
// call PURCHASES up to 10 Twilio numbers with recurring monthly cost, and it is
// repeatable.
function isAuthorizedCronRequest(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) return !isProductionRuntime();
  return req.headers.get("authorization") === `Bearer ${cronSecret}`;
}

export async function GET(req: Request) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const db = createSupabaseServiceRoleClient();
  const result = await backfillManagerWorkNumbers(db, { limit: 10 });
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
