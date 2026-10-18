import { NextResponse } from "next/server";
import { runLeadFollowUps } from "@/lib/one-number/lead-followups.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
export const maxDuration = 120;

/** Hourly: the 24h and 72h nudges for quiet Unassigned leads, and one text when a room opens for a no-match lead. */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  try {
    const summary = await runLeadFollowUps(createSupabaseServiceRoleClient());
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Lead follow-ups failed." }, { status: 503 });
  }
}
