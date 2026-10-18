import { NextResponse } from "next/server";
import { runMovedNoticeQueue } from "@/lib/one-number/old-number.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
export const maxDuration = 120;

/** Every 5 minutes: the one-time "We've moved" texts `cutover.mjs --notify-moved` queued, sent from the shared number as PropLane. */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  try {
    const summary = await runMovedNoticeQueue(createSupabaseServiceRoleClient());
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Moved notices failed." }, { status: 503 });
  }
}
