import { NextResponse } from "next/server";
import { isProductionRuntime } from "@/lib/server-env";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { expireShortStayHolds } from "@/lib/short-stay-hold-expiry.server";
import { releaseUnpaidConfirmedStays } from "@/lib/short-stay/unpaid-expiry.server";

export const runtime = "nodejs";
export const maxDuration = 120;

function isAuthorized(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) return !process.env.VERCEL_ENV && !isProductionRuntime();
  return req.headers.get("authorization") === `Bearer ${cronSecret}`;
}

/** Expires short-stay holds (a guest request after its 24 hours, a legacy checkout hold after 15 minutes) and releases confirmed stays left unpaid for 24 hours. */
export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const db = createSupabaseServiceRoleClient();
  const result = await expireShortStayHolds(db);
  // A confirmed stay still unpaid 24 hours after confirmation gives its nights back (same run, same cadence).
  const unpaid = await releaseUnpaidConfirmedStays(db).catch((error) => ({ checked: 0, released: 0, kept: 0, failed: 1, errors: [error instanceof Error ? error.message : String(error)] }));
  return NextResponse.json({ ...result, unpaidConfirmed: unpaid });
}
