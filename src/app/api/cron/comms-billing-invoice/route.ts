import { NextResponse } from "next/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { isProductionRuntime } from "@/lib/server-env";
import { invoiceManagerCommsUsage } from "@/lib/comms-billing/stripe-invoicing.server";
import { isCommsPaygBillingEnabled } from "@/lib/comms-billing/rates";
import { recordManagerCommsUsage } from "@/lib/comms-billing/record-usage.server";
import { evaluateManagerCommsBillingGate } from "@/lib/comms-billing/eligibility.server";

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

  // The monthly rental for every active work number, charged before the sweep
  // so it lands on the same invoice as the usage it belongs with. The
  // idempotency key carries the billing month, so re-running the cron in the
  // same month records nothing further.
  const month = new Date().toISOString().slice(0, 7);
  // Paged: PostgREST caps a response at max_rows (1000), so an unpaginated read
  // silently stops renting numbers once the fleet passes that size.
  const PAGE = 500;
  const rentalFailures: string[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data: page, error: pageError } = await db
      .from("manager_sms_numbers")
      .select("manager_user_id, phone_number")
      .eq("provision_state", "active")
      .not("phone_number", "is", null)
      .order("manager_user_id", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (pageError) {
      rentalFailures.push(`rental page ${offset}: ${pageError.message}`);
      break;
    }
    const rows = page ?? [];
    for (const row of rows) {
      const managerUserId = String((row as { manager_user_id?: unknown }).manager_user_id ?? "").trim();
      if (!managerUserId) continue;
      // Do not rent a number to someone the gate will not let send. A manager
      // blocked for billing reasons would otherwise be charged monthly for a
      // line they cannot use.
      const gate = await evaluateManagerCommsBillingGate(db, managerUserId);
      if (!gate.allowed) continue;
      const rec = await recordManagerCommsUsage(db, {
        managerUserId,
        meter: "work_number_monthly",
        idempotencyKey: `work_number_monthly:${managerUserId}:${month}`,
        metadata: { month, phoneNumber: (row as { phone_number?: unknown }).phone_number ?? null },
      });
      // A dropped write means an unbilled month that nothing would ever notice.
      if (!rec.recorded && !rec.duplicate) rentalFailures.push(`rental ${managerUserId}: not recorded`);
    }
    if (rows.length < PAGE) break;
  }

  // Also paged, and for the same reason: `.limit(2000)` is silently clamped to
  // PostgREST's max_rows, so past ~1000 unbilled rows the managers outside that
  // page were never invoiced at all.
  const managerIdSet = new Set<string>();
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await db
      .from("manager_comms_usage_events")
      .select("manager_user_id")
      .is("billed_at", null)
      .order("manager_user_id", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const rows = data ?? [];
    for (const r of rows) {
      const id = String((r as { manager_user_id?: unknown }).manager_user_id ?? "").trim();
      if (id) managerIdSet.add(id);
    }
    if (rows.length < PAGE) break;
  }
  const managerIds = [...managerIdSet];

  let invoiced = 0;
  let skipped = 0;
  const failures: string[] = [...rentalFailures];
  for (const managerUserId of managerIds) {
    // try/catch, not just the ok flag: getStripe() throws outright on a missing
    // key, and any Supabase error throws too. Without this one manager's throw
    // ends the run for everyone after them — which is exactly what the
    // isolation comment above promises does not happen.
    try {
      const res = await invoiceManagerCommsUsage(db, managerUserId);
      if (!res.ok) failures.push(`${managerUserId}: ${res.error}`);
      else if (res.invoiced) invoiced += 1;
      else skipped += 1;
    } catch (e) {
      failures.push(`${managerUserId}: ${e instanceof Error ? e.message : "threw"}`);
    }
  }

  return NextResponse.json({
    ok: failures.length === 0,
    managers: managerIds.length,
    invoiced,
    skipped,
    failures,
  });
}
