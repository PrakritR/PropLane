import { NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/cron-auth.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { expireHoldingDeposits } from "@/lib/holding-deposit-expiry.server";

export const runtime = "nodejs";
export const maxDuration = 120;

/** Hourly. Expires paid hold fees whose 7 days ran out without a signed lease: room released, manager told, money kept. */
export async function GET(req: Request) {
  if (!requireCronSecret(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json(await expireHoldingDeposits(createSupabaseServiceRoleClient()));
  } catch (e) {
    console.error("[expire-holding-deposits]", e instanceof Error ? e.message : "failed");
    return NextResponse.json({ error: "expiry failed" }, { status: 500 });
  }
}
