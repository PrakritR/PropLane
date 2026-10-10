import { requireCronSecret } from "@/lib/cron-auth.server";
import { NextResponse } from "next/server";

import { deliverBookingsTodayDigests } from "@/lib/reminders/subjects/bookings-today.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

/**
 * BUILD-WAVE2 C211 — "Today at your houses: 3 check-ins, 1 check-out." at
 * 8 AM Pacific. Scheduled at 15:00 UTC in vercel.json, which lands the
 * message at 8 AM Pacific in winter (PST, UTC-8) and 7 AM in summer (PDT,
 * UTC-7) — the same fixed-UTC-time convention every other cron in this file
 * already uses (none of them DST-adjust); `deliverBookingsTodayDigests`'
 * idempotency key is per Pacific calendar day, so re-running this later in
 * the day is always safe, it just never sends a second notice for the day.
 */
export async function GET(req: Request) {
  if (!requireCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const db = createSupabaseServiceRoleClient();
  const result = await deliverBookingsTodayDigests(db, new Date());
  return NextResponse.json({ ok: result.errors.length === 0, ...result, errors: result.errors.slice(0, 25) });
}
