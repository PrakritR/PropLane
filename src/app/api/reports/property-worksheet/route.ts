import { NextResponse } from "next/server";
import { assertManagerFinancialsAccess, getReportsAuthContext } from "@/lib/reports/auth";
import { resolveManagerReportScope } from "@/lib/reports/co-manager-report-scope";
import { activeWorkspacePropertyScope } from "@/lib/workspaces/scope.server";
import { applyReportPropertyScope, intersectPropertyScopes } from "@/lib/reports/workspace-scope";
import { queryFinancialActivity } from "@/lib/reports/queries/financial-activity";
import { checkedSum, parseWorksheetUpdate, propertyCashGroups, type PropertyWorksheet } from "@/lib/reports/property-worksheet";
import { reportToCsv } from "@/lib/reports/export/csv";
import { reportToPdf } from "@/lib/reports/export/pdf";
import { centsToUsd } from "@/lib/reports/money";
import type { ReportResult } from "@/lib/reports/types";
export const runtime = "nodejs";
async function context() {
  const auth = await getReportsAuthContext({ preferRole: "manager" });
  if (!auth) throw new Error("Unauthorized.");
  const gate = await assertManagerFinancialsAccess(auth); if (!gate.ok) throw new Error(gate.error);
  const scope = await resolveManagerReportScope(auth.db, auth.userId);
  const workspacePropertyIds = intersectPropertyScopes(await activeWorkspacePropertyScope(auth.db, auth.userId), scope.grantedPropertyIds);
  return { auth, managerUserId: scope.managerUserId, workspacePropertyIds };
}
export async function GET(req: Request) {
  try {
    const { auth, managerUserId, workspacePropertyIds } = await context();
    const params = new URL(req.url).searchParams, propertyId = params.get("propertyId") || undefined;
    const period = params.get("period") || new Date().toISOString().slice(0, 7);
    if (!/^\d{4}(-(?:0[1-9]|1[0-2]))?$/.test(period)) return NextResponse.json({ error: "Invalid period." }, { status: 400 });
    const to = period.length === 4 ? `${period}-12-31` : `${period}-${new Date(Date.UTC(Number(period.slice(0,4)), Number(period.slice(5)), 0)).getUTCDate()}`;
    const unallocated = propertyId === "_unallocated";
    const filters = { workspacePropertyIds, propertyId: unallocated ? undefined : propertyId, to };
    const report = await queryFinancialActivity(auth.db, managerUserId, filters);
    const all = report.rows.filter(row => !unallocated || !row.propertyId);
    const rows = all.filter(row => String(row.date).startsWith(period));
    let propertyQuery = auth.db.from("manager_property_records").select("id, row_data, property_data, finance_worksheet").eq("manager_user_id", managerUserId).order("id");
    propertyQuery = applyReportPropertyScope(propertyQuery, { workspacePropertyIds }, undefined, "id");
    const properties = [];
    for (let offset = 0; ; offset += 500) { const { data, error } = await propertyQuery.range(offset, offset + 499); if (error) throw new Error(error.message); properties.push(...(data ?? [])); if (!data || data.length < 500) break; }
    const property = properties.find(p => p.id === propertyId);
    if (propertyId && !unallocated && !property) return NextResponse.json({ error: "Property not found." }, { status: 404 });
    const worksheet = (property?.finance_worksheet ?? {}) as PropertyWorksheet;
    if (worksheet.capital) parseWorksheetUpdate({ kind: "capital", values: worksheet.capital });
    for (const [storedPeriod, source] of Object.entries(worksheet.reported ?? {})) parseWorksheetUpdate({ kind: "reported", period: storedPeriod, ...source });
    const cashCents = checkedSum(rows.map(row => Number(row.amountCents)));
    const depositCents = checkedSum(all.filter(row => /deposit/.test(String(row.categoryCode))).map(row => Number(row.amountCents)));
    const source = worksheet.reported?.[period];
    const normalizedCents = source?.amountCents == null ? null : checkedSum([source.amountCents * (source.convention === "expense_positive" ? -1 : 1)]);
    const differenceCents = normalizedCents === null ? null : checkedSum([cashCents, -normalizedCents]);
    const exportReport: ReportResult = { ...report, id: "property-worksheet", title: "By property", rows, totals: { description: "Net cash movement", amount: centsToUsd(cashCents) } };
    const format = params.get("format");
    if (format === "csv" || format === "pdf") {
      exportReport.rows = [...rows, { description: "Reported source total", amount: source?.amountCents == null ? "Not set" : centsToUsd(source.amountCents) }, { description: "Source convention", amount: source?.convention ?? "Not set" }, { description: "Normalized reported total", amount: normalizedCents === null ? "Not set" : centsToUsd(normalizedCents) }, { description: "Difference", amount: differenceCents === null ? "Not set" : centsToUsd(differenceCents) }, ...Object.entries(worksheet.capital ?? {}).map(([label, amount]) => ({ description: label, amount: centsToUsd(amount) }))];
      return new Response(format === "csv" ? reportToCsv(exportReport) : Buffer.from(await reportToPdf(exportReport)), { headers: { "Content-Type": format === "csv" ? "text/csv" : "application/pdf", "Content-Disposition": `attachment; filename="property-ledger-${period}.${format}"` } });
    }
    return NextResponse.json({ properties: properties.map(p => ({ id: p.id, label: p.property_data?.title || p.property_data?.buildingName || p.row_data?.buildingName || "Property" })), worksheet, rows, groups: propertyCashGroups(rows), groupTotals: Object.fromEntries(Object.entries(propertyCashGroups(rows)).map(([name, categories]) => [name, checkedSum(Object.values(categories).map(category => category.amountCents))])), cashCents, depositCents, normalizedCents, differenceCents, editable: managerUserId === auth.userId && Boolean(property) });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Could not load worksheet." }, { status: 400 }); }
}
export async function PATCH(req: Request) {
  try {
    const { auth, managerUserId, workspacePropertyIds } = await context();
    if (auth.userId !== managerUserId) return NextResponse.json({ error: "Only the property owner can edit source values." }, { status: 403 });
    const body = await req.json();
    if (!body.propertyId || (workspacePropertyIds && !workspacePropertyIds.includes(body.propertyId))) return NextResponse.json({ error: "Property outside workspace." }, { status: 403 });
    const update = parseWorksheetUpdate(body);
    const { data, error } = await auth.db.rpc("save_property_finance_worksheet", { p_owner: auth.userId, p_property: body.propertyId, p_path: update.path, p_value: update.value });
    if (error) throw new Error(error.message);
    return NextResponse.json({ worksheet: data });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Could not save worksheet." }, { status: 400 }); }
}
