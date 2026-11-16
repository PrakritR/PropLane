/**
 * Recurring payables tick: every active schedule gets its next Due entry (idempotent per payable and due
 * date) and steps forward. Daily; an entry is generated a few days ahead of its due date.
 */
import { NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/cron-auth.server";
import { generateDueRecurringEntries } from "@/lib/finance/recurring-payables.server";
import { pacificCalendarDateYmd } from "@/lib/pacific-time";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(req: Request) {
  if (!requireCronSecret(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const summary = await generateDueRecurringEntries(createSupabaseServiceRoleClient(), pacificCalendarDateYmd());
    return NextResponse.json({ ok: summary.errors.length === 0, ...summary });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "recurring payables failed" }, { status: 500 });
  }
}
