import { NextResponse } from "next/server";
import { isProductionRuntime } from "@/lib/server-env";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { expireHoldingDeposits } from "@/lib/holding-deposit-expiry.server";

export const runtime = "nodejs";
export const maxDuration = 120;

function isAuthorized(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) return !process.env.VERCEL_ENV && !isProductionRuntime();
  return req.headers.get("authorization") === `Bearer ${cronSecret}`;
}

/** Hourly. Expires paid hold fees whose 7 days ran out without a signed lease: room released, manager told, money kept. */
export async function GET(req: Request) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json(await expireHoldingDeposits(createSupabaseServiceRoleClient()));
  } catch (e) {
    console.error("[expire-holding-deposits]", e instanceof Error ? e.message : "failed");
    return NextResponse.json({ error: "expiry failed" }, { status: 500 });
  }
}
