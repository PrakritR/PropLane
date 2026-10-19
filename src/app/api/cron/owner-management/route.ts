import { NextResponse } from "next/server";
import { isProductionRuntime } from "@/lib/server-env";
import { getStripe } from "@/lib/stripe";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { reconcileManagedLedger } from "@/lib/managed-finance/reconcile.server";
import { batchWeekKey, runWeeklyVendorBatch } from "@/lib/managed-finance/withdrawals.server";
import { sendMonthlyOwnerStatements } from "@/lib/owner-management/monthly-statements.server";

export const runtime = "nodejs";
export const maxDuration = 300;

function isAuthorized(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) return !process.env.VERCEL_ENV && !isProductionRuntime();
  return req.headers.get("authorization") === `Bearer ${cronSecret}`;
}

/**
 * Hourly. Reconciles the party ledger and settles stuck withdrawals every run; on Mondays (Pacific) pays each vendor's weekly
 * batch once (idempotent per vendor and week); on the 1st (Pacific) sends last month's owner statements once (idempotent per
 * workspace and month). Moves real money only through the same reserve -> transfer path as a manual withdrawal.
 */
export async function GET(req: Request) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = createSupabaseServiceRoleClient();
  const stripe = getStripe();
  const now = new Date();
  const out: Record<string, unknown> = {};
  const stage = async (name: string, run: () => Promise<unknown>) => {
    try {
      out[name] = await run();
    } catch (e) {
      out[name] = { error: e instanceof Error ? e.message : "failed" };
    }
  };
  await stage("reconcile", () => reconcileManagedLedger(db, stripe, now));
  const day = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short", day: "numeric" }).formatToParts(now);
  const weekday = day.find((p) => p.type === "weekday")?.value;
  const dom = Number(day.find((p) => p.type === "day")?.value);
  if (weekday === "Mon") await stage("vendorBatch", () => runWeeklyVendorBatch(stripe, db, now));
  else out.vendorBatch = { skipped: `next ${batchWeekKey(now)}` };
  if (dom === 1) await stage("statements", () => sendMonthlyOwnerStatements(db, now));
  return NextResponse.json(out);
}
