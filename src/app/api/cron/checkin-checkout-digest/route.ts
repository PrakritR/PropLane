import { NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/cron-auth.server";
import { runCheckinCheckoutDigest } from "@/lib/one-number/checkin-digest.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * 7am Pacific. Vercel crons run on UTC, so this is scheduled at both 14:00 and 15:00 UTC and the run itself
 * only acts when it is 7 o'clock in Pacific time (14:00 UTC in summer/PDT, 15:00 UTC in winter/PST); the
 * per-house-per-day idempotency key makes a repeat harmless.
 */
export async function GET(req: Request) {
  if (!requireCronSecret(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const summary = await runCheckinCheckoutDigest(createSupabaseServiceRoleClient());
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Check-in digest failed." }, { status: 503 });
  }
}
