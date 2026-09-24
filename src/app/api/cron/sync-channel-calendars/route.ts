import { NextResponse } from "next/server";

import { isProductionRuntime } from "@/lib/server-env";
import { syncAllChannelCalendarImports } from "@/lib/channel-calendar/sync.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
export const maxDuration = 120;

function isAuthorized(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) return !isProductionRuntime();
  return req.headers.get("authorization") === `Bearer ${cronSecret}`;
}

/** Pull every saved Airbnb / Booking.com import URL on a schedule. */
export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = createSupabaseServiceRoleClient();
  const result = await syncAllChannelCalendarImports(db);
  return NextResponse.json(result);
}
