import { NextResponse } from "next/server";
import { isProductionRuntime } from "@/lib/server-env";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { loadActiveRentReportingEnrollments } from "@/lib/rent-reporting/consent.server";
import { buildRentReportingRowsForPeriod } from "@/lib/rent-reporting/export.server";
import { getRentReportingPartner } from "@/lib/rent-reporting/partner";
import { loadRentReportingAddonSettings } from "@/lib/rent-reporting/manager-settings.server";

export const runtime = "nodejs";

function isAuthorized(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) {
    // Same rule as comms-billing-invoice: preview deployments are public and
    // hold real credentials, so secretless access is a localhost convenience
    // only. This one submits consumer credit data, so it fails closed
    // everywhere else.
    return !process.env.VERCEL_ENV && !isProductionRuntime();
  }
  return req.headers.get("authorization") === `Bearer ${cronSecret}`;
}

/** The calendar month before `now`, as `YYYY-MM` — this job runs on the 5th and reports the month that just closed. */
function previousMonthKey(now: Date): string {
  const firstOfPrevMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${firstOfPrevMonth.getUTCFullYear()}-${String(firstOfPrevMonth.getUTCMonth() + 1).padStart(2, "0")}`;
}

function submissionKey(reportingId: string, period: string): string {
  return `${reportingId}::${period}`;
}

/**
 * Monthly submission to the rent reporting partner (`vercel.json`, the 5th of each
 * month). Idempotent by `(reporting_id, period)`: a redelivered run only ever submits
 * the rows this exact period has not already recorded. A manager who has since turned
 * the add-on off is skipped even if a resident's own consent row is still `active` —
 * the add-on gate applies every cycle, not just at signup.
 */
export async function GET(req: Request) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = createSupabaseServiceRoleClient();
  const period = previousMonthKey(new Date());

  const enrollments = await loadActiveRentReportingEnrollments(db);
  if (enrollments.length === 0) return NextResponse.json({ period, submitted: 0 });

  const managerIds = [...new Set(enrollments.map((e) => e.managerUserId))];
  const enabledManagers = new Set<string>();
  for (const managerId of managerIds) {
    const settings = await loadRentReportingAddonSettings(db, managerId);
    if (settings.enabled) enabledManagers.add(managerId);
  }
  const eligible = enrollments.filter((e) => enabledManagers.has(e.managerUserId));
  if (eligible.length === 0) return NextResponse.json({ period, submitted: 0 });

  const rows = await buildRentReportingRowsForPeriod(db, period, eligible);
  if (rows.length === 0) return NextResponse.json({ period, submitted: 0 });

  const { data: existingRows, error: existingError } = await db
    .from("rent_reporting_submissions")
    .select("reporting_id, period")
    .eq("period", period)
    .in(
      "reporting_id",
      rows.map((r) => r.reportingId),
    );
  if (existingError) return NextResponse.json({ error: existingError.message }, { status: 500 });
  const existingKeys = new Set((existingRows ?? []).map((r) => submissionKey(r.reporting_id as string, r.period as string)));
  const newRows = rows.filter((r) => !existingKeys.has(submissionKey(r.reportingId, r.period)));
  if (newRows.length === 0) return NextResponse.json({ period, submitted: 0, alreadySent: rows.length });

  const partner = getRentReportingPartner();
  const receipts = await partner.submit(
    newRows.map((r) => ({
      reportingId: r.reportingId,
      partnerSubjectId: r.partnerSubjectId ?? "",
      period: r.period,
      amountCents: r.amountCents,
      dueDate: r.dueDate,
      paidDate: r.paidDate,
      status: r.status,
    })),
  );

  const now = new Date().toISOString();
  const insertRows = newRows.map((r) => ({
    reporting_id: r.reportingId,
    resident_user_id: r.residentUserId,
    period: r.period,
    amount_cents: r.amountCents,
    due_date: r.dueDate,
    paid_date: r.paidDate,
    status: r.status,
    sent_at: now,
    partner_receipt: receipts.get(submissionKey(r.reportingId, r.period)) ?? null,
  }));

  const { error: insertError } = await db
    .from("rent_reporting_submissions")
    .upsert(insertRows, { onConflict: "reporting_id,period" });
  if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 });

  return NextResponse.json({ period, submitted: insertRows.length });
}
