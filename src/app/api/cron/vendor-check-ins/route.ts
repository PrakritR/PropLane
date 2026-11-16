/**
 * Vendor check-ins tick (Finance Phase A, cleaner check-ins): sends every check-in whose time has come (the 1st and
 * 14th, 10:00 Pacific, for the cleaner) and runs the "no / no reply" rule. Every 10 minutes; one send per
 * (vendor, check-in, Pacific date).
 */
import { NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/cron-auth.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { sweepVendorCheckIns } from "@/lib/vendor-check-ins.server";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(req: Request) {
  if (!requireCronSecret(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const summary = await sweepVendorCheckIns(createSupabaseServiceRoleClient());
    return NextResponse.json({ ok: summary.errors.length === 0, ...summary });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "check-ins failed" }, { status: 500 });
  }
}
