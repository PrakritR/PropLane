import { NextResponse } from "next/server";

import { syncGmailPaymentReceipts } from "@/lib/gmail-payments/sync.server";
import { loadGmailPaymentsConnection } from "@/lib/gmail-payments/settings";
import { householdChargeDueDate, type HouseholdCharge } from "@/lib/household-charges";
import { isProductionRuntime } from "@/lib/server-env";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  return secret ? req.headers.get("authorization") === `Bearer ${secret}` : !isProductionRuntime();
}

/** More urgent rent gets checked more often, without treating an old receipt as new. */
function minimumIntervalMs(charges: HouseholdCharge[], now: Date): number {
  let nearestMs = Number.POSITIVE_INFINITY;
  for (const charge of charges) {
    const due = householdChargeDueDate(charge);
    if (due) nearestMs = Math.min(nearestMs, due.getTime() - now.getTime());
  }
  const hours = nearestMs / (60 * 60 * 1000);
  if (hours <= 48) return 60 * 60 * 1000; // due / overdue: each scheduled run
  if (hours <= 7 * 24) return 6 * 60 * 60 * 1000;
  return 24 * 60 * 60 * 1000;
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = createSupabaseServiceRoleClient();
  const { data, error } = await db
    .from("portal_household_charge_records")
    .select("manager_user_id, row_data")
    .eq("status", "pending")
    .limit(5000);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const byManager = new Map<string, HouseholdCharge[]>();
  for (const row of data ?? []) {
    const managerId = String(row.manager_user_id ?? "").trim();
    const charge = row.row_data as HouseholdCharge | null;
    if (!managerId || !charge?.id || (!charge.zelleContactSnapshot && !charge.venmoContactSnapshot)) continue;
    const list = byManager.get(managerId) ?? [];
    list.push(charge);
    byManager.set(managerId, list);
  }

  const now = new Date();
  let checked = 0;
  let skipped = 0;
  let markedPaid = 0;
  const errors: string[] = [];
  for (const [managerId, charges] of byManager) {
    const connection = await loadGmailPaymentsConnection(db, managerId, "manager").catch(() => null);
    if (!connection?.connected) {
      skipped += 1;
      continue;
    }
    const last = connection.lastSyncAt ? Date.parse(connection.lastSyncAt) : 0;
    if (Number.isFinite(last) && now.getTime() - last < minimumIntervalMs(charges, now)) {
      skipped += 1;
      continue;
    }
    try {
      const result = await syncGmailPaymentReceipts(db, managerId, "manager");
      checked += 1;
      markedPaid += result.markedPaid;
      errors.push(...result.errors.map((message) => `${managerId}: ${message}`));
    } catch (cause) {
      errors.push(`${managerId}: ${cause instanceof Error ? cause.message : "sync failed"}`);
    }
  }
  return NextResponse.json({ considered: byManager.size, checked, skipped, markedPaid, errors });
}
