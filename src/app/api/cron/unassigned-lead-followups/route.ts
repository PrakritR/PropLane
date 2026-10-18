import { NextResponse } from "next/server";
import { runLeadFollowUps } from "@/lib/one-number/lead-followups.server";
import { runProspectRoomMatches } from "@/lib/one-number/prospect-room-matches.server";
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
    const db = createSupabaseServiceRoleClient();
    const summary = await runLeadFollowUps(db);
    // A team's past prospect is texted once when a new room of that team's fits what they asked for.
    const rooms = await runProspectRoomMatches(db).catch(() => null);
    return NextResponse.json({ ok: true, ...summary, ...(rooms ? { roomMatches: rooms } : {}) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Lead follow-ups failed." }, { status: 503 });
  }
}
