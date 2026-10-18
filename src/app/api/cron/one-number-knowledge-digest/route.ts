import { NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/cron-auth.server";
import { runWeeklyKnowledgeDigest } from "@/lib/one-number/knowledge/weekly-digest.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

/** Weekly: each workspace's top unanswered questions, as one Assistant notice to the owner. */
export async function GET(req: Request) {
  if (!requireCronSecret(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const result = await runWeeklyKnowledgeDigest(createSupabaseServiceRoleClient());
  return NextResponse.json({ ok: true, ...result });
}
