import { NextResponse } from "next/server";
import {
  assertManagerFinancialsAccess,
  assertResidentFinancialsAccess,
  getReportsAuthContext,
} from "@/lib/reports/auth";
import { reportToCsv } from "@/lib/reports/export/csv";
import { buildQuickBooksJournalCsv } from "@/lib/reports/export/quickbooks-csv";
import { reportToPdf } from "@/lib/reports/export/pdf";
import { parseManagerReportFilters } from "@/lib/reports/parse-filters";
import { resolveManagerReportOwnerId } from "@/lib/reports/co-manager-report-scope";
import {
  MANAGER_REPORT_IDS,
  RESIDENT_REPORT_IDS,
} from "@/lib/reports/types";
import { runManagerReport, queryResidentLedger } from "@/lib/reports/queries";
import { activeWorkspacePropertyScope } from "@/lib/workspaces/scope.server";
import type { ManagerReportFilters } from "@/lib/reports/types";

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
    const formatParam = searchParams.get("format");
    const format = formatParam === "pdf" ? "pdf" : formatParam === "quickbooks" ? "quickbooks" : "csv";

    // Co-managers granted `financials` export the owning manager's books (owner-level scope).
    let managerUserId = auth.userId;
    let managerFilters: ManagerReportFilters | null = null;
    let report;
    if (isResidentReport) {
      const gate = await assertResidentFinancialsAccess(auth);
      if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });
      const filters = {
        from: searchParams.get("from")?.trim() || undefined,
        to: searchParams.get("to")?.trim() || undefined,
      };
      report = await queryResidentLedger(auth.db, auth.userId, auth.email, filters);
    } else {
      if (!MANAGER_REPORT_IDS.includes(reportId as (typeof MANAGER_REPORT_IDS)[number])) {
        return NextResponse.json({ error: "Unknown report." }, { status: 404 });
      }
      const gate = await assertManagerFinancialsAccess(auth);
      if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });
      managerUserId =
        auth.role === "admin"
          ? searchParams.get("managerUserId")?.trim() || auth.userId
          : await resolveManagerReportOwnerId(auth.db, auth.userId);
      // Same workspace narrowing as the on-screen report, so an export can
      // never carry rows the page itself would not show.
      managerFilters = parseManagerReportFilters(searchParams);
      managerFilters.workspacePropertyIds = await activeWorkspacePropertyScope(auth.db, auth.userId);
      report = await runManagerReport(auth.db, managerUserId, reportId, managerFilters);
    }

    if (!report) return NextResponse.json({ error: "Unknown report." }, { status: 404 });

    const filenameBase = `${report.id}-${new Date().toISOString().slice(0, 10)}`;

    if (format === "pdf") {
      // disposition=inline lets same-origin preview frames render the PDF instead of downloading it.
      const disposition = searchParams.get("disposition") === "inline" ? "inline" : "attachment";
      const bytes = await reportToPdf(report);
      return new NextResponse(Buffer.from(bytes), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `${disposition}; filename="${filenameBase}.pdf"`,
        },
      });
    }

    if (format === "quickbooks") {
      if (isResidentReport) {
        return NextResponse.json({ error: "QuickBooks export is manager-only." }, { status: 400 });
      }
      const qbCsv = await buildQuickBooksJournalCsv(
        auth.db,
        managerUserId,
        managerFilters ?? parseManagerReportFilters(searchParams),
      );
      return new NextResponse(qbCsv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filenameBase}-quickbooks.csv"`,
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
    const message = e instanceof Error ? e.message : "Failed to export report.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
