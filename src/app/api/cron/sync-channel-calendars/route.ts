import { requireCronSecret } from "@/lib/cron-auth.server";
import { NextResponse } from "next/server";

import { notifyFailingChannelSyncs } from "@/lib/channel-calendar/channel-sync-notice.server";
import { syncAllChannelCalendarImports } from "@/lib/channel-calendar/sync.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
export const maxDuration = 120;

/** Pull every saved Airbnb / Booking.com / Vrbo import URL on a schedule. */
export async function GET(req: Request) {
  if (!requireCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = createSupabaseServiceRoleClient();
  const result = await syncAllChannelCalendarImports(db);
  // A connection that has not synced for hours tells its manager once a day. Best-effort: never fails the sync run.
  const notices = await notifyFailingChannelSyncs(db).catch((e) => {
    console.warn("[channel-calendar] sync failure notices failed", e instanceof Error ? e.message : String(e));
    return null;
  });
  return NextResponse.json({ ...result, ...(notices ? { failingNotified: notices.notified } : {}) });
}
