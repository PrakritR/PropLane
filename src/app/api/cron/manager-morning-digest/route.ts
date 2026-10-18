import { NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/cron-auth.server";
import { runMorningDigests } from "@/lib/one-number/morning-digest.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * 8am Pacific. Vercel crons run on UTC, so this is scheduled at both 15:00 and 16:00 UTC and the run
 * itself only acts when it is 8 o'clock in Pacific time (one of the two, in either half of the year);
 * the per-person dedupe key makes a repeat harmless.
 */
export async function GET(req: Request) {
  if (!requireCronSecret(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const summary = await runMorningDigests(createSupabaseServiceRoleClient());
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Morning digest failed." }, { status: 503 });
  }
}
