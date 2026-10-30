import { NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/cron-auth.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

export async function GET(req: Request) {
  if (!requireCronSecret(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = createSupabaseServiceRoleClient();
  for (const name of ["purge_expired_email_onboarding_handoffs", "purge_expired_tour_signup_capabilities"] as const) {
    const { error } = await db.rpc(name);
    if (error) return NextResponse.json({ error: "Cleanup failed" }, { status: 503 });
  }
  return NextResponse.json({ ok: true });
}
