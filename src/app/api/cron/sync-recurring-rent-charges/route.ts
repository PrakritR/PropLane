import { NextResponse } from "next/server";
import { isProductionRuntime } from "@/lib/server-env";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { runRecurringRentSweep } from "@/lib/recurring-rent-cron.server";

export const runtime = "nodejs";
export const maxDuration = 300;

const SLOW_MS = 3000;

function isAuthorized(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) return !process.env.VERCEL_ENV && !isProductionRuntime();
  return req.headers.get("authorization") === `Bearer ${cronSecret}`;
}

/** Daily: current + next month rent charges for every active recurring profile, with no portal visit needed. */
export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const started = Date.now();
  const result = await runRecurringRentSweep(createSupabaseServiceRoleClient());
  const ms = Date.now() - started;
  if (ms > SLOW_MS) console.warn(`[cron/sync-recurring-rent-charges] slow sweep ${ms}ms`, { managers: result.managers, created: result.created });
  return NextResponse.json(result, {
    status: result.errors.length > 0 && result.created === 0 ? 500 : 200,
    headers: { "Server-Timing": `sweep;dur=${ms}` },
  });
}
