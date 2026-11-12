import { NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/cron-auth.server";
import { runStayMessagesOnDb } from "@/lib/stay-messages/send.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Automated check-in (10:00 the day before) and check-out (09:00 the day of) messages, America/Los_Angeles. Every five
 * minutes: a booking made inside its window is sent promptly, and the ledger (`stay_message_sends`) makes every stay's
 * message exactly-once across retries and calendar re-imports.
 */
export async function GET(req: Request) {
  if (!requireCronSecret(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const summary = await runStayMessagesOnDb(createSupabaseServiceRoleClient());
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Stay messages failed." }, { status: 503 });
  }
}
