import { NextResponse } from "next/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { isProductionRuntime } from "@/lib/server-env";
import { invoiceManagerCommsUsage } from "@/lib/comms-billing/stripe-invoicing.server";
import { isCommsPaygBillingEnabled } from "@/lib/comms-billing/rates";

export const runtime = "nodejs";
export const maxDuration = 300;

function isAuthorized(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) {
    // Same rule as every other cron here: preview deployments are public and
    // hold real credentials, so secretless access is a localhost convenience
    // only. This one moves money, so it fails closed everywhere else.
    return !process.env.VERCEL_ENV && !isProductionRuntime();
  }
  return req.headers.get("authorization") === `Bearer ${cronSecret}`;
}

/**
 * Bills outstanding communication usage, one manager at a time.
 *
 * Per-manager isolation is deliberate: one manager's Stripe failure (a declined
 * card, a deleted customer) must not stop everyone else's usage from being
 * invoiced. Failures are counted and reported, never thrown.
 */
export async function GET(req: Request) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  if (!isCommsPaygBillingEnabled()) return NextResponse.json({ ok: true, skipped: "payg_disabled" });

  const db = createSupabaseServiceRoleClient();
  const { data, error } = await db
    .from("manager_comms_usage_events")
    .select("manager_user_id")
    .is("billed_at", null)
    .limit(2000);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const managerIds = [...new Set((data ?? []).map((r) => String((r as { manager_user_id?: unknown }).manager_user_id ?? "").trim()).filter(Boolean))];

  let invoiced = 0;
  let skipped = 0;
  const failures: string[] = [];
  for (const managerUserId of managerIds) {
    const res = await invoiceManagerCommsUsage(db, managerUserId);
    if (!res.ok) failures.push(`${managerUserId}: ${res.error}`);
    else if (res.invoiced) invoiced += 1;
    else skipped += 1;
  }

  return NextResponse.json({
    ok: failures.length === 0,
    managers: managerIds.length,
    invoiced,
    skipped,
    failures,
  });
}
