import { NextResponse } from "next/server";
import { getReportsAuthContext, assertManagerFinancialsAccess } from "@/lib/reports/auth";
import { resolveManagerReportScope } from "@/lib/reports/co-manager-report-scope";
import { activeWorkspacePropertyScope } from "@/lib/workspaces/scope.server";
import { applyReportPropertyScope, intersectPropertyScopes } from "@/lib/reports/workspace-scope";
import { reportToCsv } from "@/lib/reports/export/csv";
import { reportToPdf } from "@/lib/reports/export/pdf";
import { centsToUsd } from "@/lib/reports/money";
import type { ReportResult, ReportRow } from "@/lib/reports/types";
const specs: Record<string, { table: string; title: string; columns: string[]; money: string[] }> = {
  bills: { table: "manager_bills", title: "Bills", columns: ["bill_number", "description", "due_date", "status", "amount_cents", "property_id"], money: ["amount_cents"] },
  "security-deposits": { table: "security_deposit_ledger", title: "Deposits", columns: ["resident_email", "received_date", "status", "amount_cents", "amount_held_cents", "property_id"], money: ["amount_cents", "amount_held_cents"] },
  "owner-distributions": { table: "manager_owner_distributions", title: "Distributions", columns: ["period_start", "period_end", "status", "distribution_cents", "property_id", "memo"], money: ["distribution_cents"] },
  "bank-reconciliation": { table: "manager_bank_statements", title: "Bank reconciliation", columns: ["bank_account_id", "statement_date", "opening_balance_cents", "closing_balance_cents", "reconciled_at"], money: ["opening_balance_cents", "closing_balance_cents"] },
};
export async function GET(req: Request) {
  try {
    const auth = await getReportsAuthContext({ preferRole: "manager" }); if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const gate = await assertManagerFinancialsAccess(auth); if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });
    const params = new URL(req.url).searchParams, kind = params.get("kind") || "", spec = specs[kind];
    if (!spec) return NextResponse.json({ error: "Unknown report." }, { status: 404 });
    const scope = await resolveManagerReportScope(auth.db, auth.userId);
    const workspacePropertyIds = intersectPropertyScopes(await activeWorkspacePropertyScope(auth.db, auth.userId), scope.grantedPropertyIds);
    // Bank statements belong to the account owner, never a property-only delegated grant.
    if (kind === "bank-reconciliation" && scope.managerUserId !== auth.userId) return NextResponse.json({ error: "Account owner access required." }, { status: 403 });
    let query = auth.db.from(spec.table).select(spec.columns.join(",")).eq("manager_user_id", scope.managerUserId).order("id");
    if (kind !== "bank-reconciliation") query = applyReportPropertyScope(query, { workspacePropertyIds });
    const rows: ReportRow[] = [];
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await query.range(offset, offset + 499); if (error) throw new Error(error.message);
      for (const raw of data ?? []) { const row = raw as unknown as Record<string, unknown>; const mapped: ReportRow = {}; for (const key of spec.columns) { if (spec.money.includes(key)) { const cents = Number(row[key]); if (!Number.isSafeInteger(cents)) throw new Error("Invalid stored amount."); mapped[key] = centsToUsd(cents); } else mapped[key] = String(row[key] ?? ""); } rows.push(mapped); }
      if (!data || data.length < 500) break;
    }
    const report: ReportResult = { id: kind, title: spec.title, columns: spec.columns.map(key => ({ key, label: key.replace(/_cents$/, "").replaceAll("_", " "), ...(spec.money.includes(key) ? { format: "money" as const, align: "right" as const } : {}) })), rows };
    const pdf = params.get("format") === "pdf";
    return new Response(pdf ? Buffer.from(await reportToPdf(report)) : reportToCsv(report), { headers: { "Content-Type": pdf ? "application/pdf" : "text/csv", "Content-Disposition": `attachment; filename="${kind}.${pdf ? "pdf" : "csv"}"` } });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Could not export report." }, { status: 500 }); }
}
