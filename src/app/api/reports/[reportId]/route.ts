import { NextResponse } from "next/server";
import {
  assertManagerFinancialsAccess,
  assertResidentFinancialsAccess,
  getReportsAuthContext,
} from "@/lib/reports/auth";
import { parseManagerReportFilters } from "@/lib/reports/parse-filters";
import { resolveManagerReportOwnerId } from "@/lib/reports/co-manager-report-scope";
import {
  MANAGER_REPORT_IDS,
  RESIDENT_REPORT_IDS,
} from "@/lib/reports/types";
import { runManagerReport, queryResidentLedger } from "@/lib/reports/queries";
import { activeWorkspacePropertyScope } from "@/lib/workspaces/scope.server";

export const runtime = "nodejs";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ reportId: string }> },
) {
  try {
    const { reportId } = await ctx.params;
    const isResidentReport = RESIDENT_REPORT_IDS.includes(reportId as (typeof RESIDENT_REPORT_IDS)[number]);
    const auth = await getReportsAuthContext({ preferRole: isResidentReport ? "resident" : "manager" });
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const searchParams = new URL(req.url).searchParams;

    if (isResidentReport) {
      const gate = await assertResidentFinancialsAccess(auth);
      if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

      const filters = {
        from: searchParams.get("from")?.trim() || undefined,
        to: searchParams.get("to")?.trim() || undefined,
      };

      if (reportId === "resident-ledger") {
        const report = await queryResidentLedger(auth.db, auth.userId, auth.email, filters);
        return NextResponse.json(report);
      }
      return NextResponse.json({ error: "Unknown report." }, { status: 404 });
    }

    if (!MANAGER_REPORT_IDS.includes(reportId as (typeof MANAGER_REPORT_IDS)[number])) {
      return NextResponse.json({ error: "Unknown report." }, { status: 404 });
    }

    const gate = await assertManagerFinancialsAccess(auth);
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

    // Co-managers granted `financials` read the owning manager's books (owner-level scope).
    const managerUserId =
      auth.role === "admin"
        ? searchParams.get("managerUserId")?.trim() || auth.userId
        : await resolveManagerReportOwnerId(auth.db, auth.userId);

    // The active workspace narrows every manager report, read from the viewer's
    // own selection cookie so the request cannot widen its own scope.
    const filters = parseManagerReportFilters(searchParams);
    filters.workspacePropertyIds = await activeWorkspacePropertyScope(auth.db, auth.userId);
    const report = await runManagerReport(auth.db, managerUserId, reportId, filters);
    if (!report) return NextResponse.json({ error: "Unknown report." }, { status: 404 });
    return NextResponse.json(report);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load report.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
