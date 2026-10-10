import { requireCronSecret } from "@/lib/cron-auth.server";
import { NextResponse } from "next/server";

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
  return NextResponse.json(result);
}
