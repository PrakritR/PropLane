import { NextResponse } from "next/server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { getPortalAccessContext } from "@/lib/auth/portal-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveAuthenticatedBusinessAccess } from "@/lib/test-workspaces/index.server";
import { reportToCsv } from "@/lib/reports/export/csv";
import { reportToPdf } from "@/lib/reports/export/pdf";
import { loadManagerTourExportRows, tourRowsToReportResult } from "@/lib/manager-tour-export.server";
import type { ScheduleRecordUser } from "@/lib/schedule-record-projection.server";
import type { ManagerTourBucketId } from "@/lib/portal-detail-routes";

export const runtime = "nodejs";

const BUCKETS: ManagerTourBucketId[] = ["pending", "upcoming", "past"];

function parseBucket(value: string | null): ManagerTourBucketId {
  return BUCKETS.includes(value as ManagerTourBucketId) ? (value as ManagerTourBucketId) : "pending";
}

/**
 * C026/C032 — CSV + a print-styled PDF export of the manager's Tours list,
 * scoped to the bucket/property filters/search the caller currently has open
 * (the same shape `FinancesExportMenu` / `/api/reports/[reportId]/export`
 * already use elsewhere). Re-derives the viewer's own scope server-side —
 * `loadManagerTourExportRows` never trusts a client-supplied ownership claim.
 */
export async function GET(req: Request) {
  try {
    const portalCtx = await getPortalAccessContext();
    if (!portalCtx.user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const db = createSupabaseServiceRoleClient();
    if ((await resolveAuthenticatedBusinessAccess(portalCtx.user.id, db)).kind === "denied") {
      return NextResponse.json({ error: "Tours export is unavailable for this account." }, { status: 403 });
    }

    const admin = await isAdminUser(portalCtx.user.id);
    const role = admin
      ? "admin"
      : String(portalCtx.effectiveRole ?? portalCtx.roles[0] ?? portalCtx.profile?.role ?? "").toLowerCase();
    if (role !== "admin" && role !== "manager") {
      return NextResponse.json({ error: "Tours export is manager-only." }, { status: 403 });
    }
    const user: ScheduleRecordUser = { id: portalCtx.user.id, role, roles: portalCtx.roles };

    const searchParams = new URL(req.url).searchParams;
    const bucket = parseBucket(searchParams.get("bucket"));
    const propertyFilters = (searchParams.get("propertyIds") ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    const search = searchParams.get("q") ?? "";
    const format = searchParams.get("format") === "pdf" ? "pdf" : "csv";

    const rows = await loadManagerTourExportRows({ db, user, bucket, propertyFilters, search });
    const report = tourRowsToReportResult(rows, bucket);
    const filenameBase = `tours-${bucket}-${new Date().toISOString().slice(0, 10)}`;

    if (format === "pdf") {
      const bytes = await reportToPdf(report);
      return new NextResponse(Buffer.from(bytes), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${filenameBase}.pdf"`,
        },
      });
    }

    const csv = reportToCsv(report);
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filenameBase}.csv"`,
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to export tours.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
