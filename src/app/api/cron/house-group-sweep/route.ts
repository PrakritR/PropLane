import { NextResponse } from "next/server";
import { runDueGroupChecks } from "@/lib/house-groups/ra.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
export const maxDuration = 120;

/** Every five minutes: unanswered house questions past ten minutes, and follow-ups held until morning. */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  try {
    const summary = await runDueGroupChecks(createSupabaseServiceRoleClient());
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "House group sweep failed." }, { status: 503 });
  }
}
