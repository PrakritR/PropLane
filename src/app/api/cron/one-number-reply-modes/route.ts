import { NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/cron-auth.server";
import { runReplyModeSweep } from "@/lib/one-number/knowledge/reply-modes.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

/** Nightly: expire unreviewed auto-review flags, then promote or demote each opted-in topic. */
export async function GET(req: Request) {
  if (!requireCronSecret(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const result = await runReplyModeSweep(createSupabaseServiceRoleClient());
  return NextResponse.json({ ok: true, expired: result.expired, moves: result.moves.length });
}
