import { NextResponse } from "next/server";
import { isProductionRuntime } from "@/lib/server-env";
import { getStripe } from "@/lib/stripe";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { releaseReadyPlatformHolds } from "@/lib/platform-hold-ready-release.server";

export const runtime = "nodejs";
export const maxDuration = 300;

function isAuthorized(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) return !process.env.VERCEL_ENV && !isProductionRuntime();
  return req.headers.get("authorization") === `Bearer ${cronSecret}`;
}

/**
 * Every 15 minutes. Releases held money to owners whose Connect account can now receive payouts, for the case where the
 * `account.updated` webhook never arrived. Idempotent end to end (see `releaseReadyPlatformHolds`).
 */
export async function GET(req: Request) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const result = await releaseReadyPlatformHolds(createSupabaseServiceRoleClient(), getStripe());
    return NextResponse.json(result);
  } catch (e) {
    console.error("[release-ready-holds]", e instanceof Error ? e.message : "failed");
    return NextResponse.json({ error: "release failed" }, { status: 500 });
  }
}
