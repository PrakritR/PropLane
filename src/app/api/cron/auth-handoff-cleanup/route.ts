import { NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/cron-auth.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

/** Each purge deletes at most this many rows per call, so one call is not one drain. */
const PURGE_BATCH = 100;
/** Ceiling on a single run: 50 batches per table, so an outsized backlog cannot run unbounded. */
const MAX_PURGE_BATCHES = 50;

export async function GET(req: Request) {
  if (!requireCronSecret(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = createSupabaseServiceRoleClient();
  const removed: Record<string, number> = {};
  for (const name of ["purge_expired_email_onboarding_handoffs", "purge_expired_tour_signup_capabilities"] as const) {
    // Handoffs expire after an hour and this cron runs hourly, so a single capped batch would let
    // any hour that minted more than PURGE_BATCH links grow the table for good. Drain until a batch
    // comes back short.
    let total = 0;
    for (let batch = 0; batch < MAX_PURGE_BATCHES; batch += 1) {
      const { data, error } = await db.rpc(name);
      if (error) return NextResponse.json({ error: "Cleanup failed" }, { status: 503 });
      const count = Number(data ?? 0);
      total += Number.isFinite(count) ? count : 0;
      if (!Number.isFinite(count) || count < PURGE_BATCH) break;
    }
    removed[name] = total;
  }
  return NextResponse.json({ ok: true, removed });
}
