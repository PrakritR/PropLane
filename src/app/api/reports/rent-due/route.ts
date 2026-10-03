import { NextResponse } from "next/server";
import { assertManagerFinancialsAccess, getReportsAuthContext } from "@/lib/reports/auth";
import { resolveManagerReportScope } from "@/lib/reports/co-manager-report-scope";
import { activeWorkspacePropertyScope } from "@/lib/workspaces/scope.server";
import { applyReportPropertyScope, intersectPropertyScopes } from "@/lib/reports/workspace-scope";
import { buildRentDueSummary } from "@/lib/reports/rent-due";
import type { HouseholdCharge } from "@/lib/household-charges";
export async function GET(req: Request) {
  try {
    const auth = await getReportsAuthContext({ preferRole: "manager" });
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const gate = await assertManagerFinancialsAccess(auth); if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });
    const scope = await resolveManagerReportScope(auth.db, auth.userId);
    const workspacePropertyIds = intersectPropertyScopes(await activeWorkspacePropertyScope(auth.db, auth.userId), scope.grantedPropertyIds);
    const params = new URL(req.url).searchParams, period = params.get("period") || "";
    if (!/^\d{4}(-(?:0[1-9]|1[0-2]))?$/.test(period)) return NextResponse.json({ error: "Invalid period." }, { status: 400 });
    let query = auth.db.from("portal_household_charge_records").select("row_data").eq("manager_user_id", scope.managerUserId).order("id");
    query = applyReportPropertyScope(query, { workspacePropertyIds, propertyId: params.get("propertyId") || undefined });
    const charges: HouseholdCharge[] = [];
    for (let offset = 0; ; offset += 500) { const { data, error } = await query.range(offset, offset + 499); if (error) throw new Error(error.message); charges.push(...(data ?? []).map(row => row.row_data as HouseholdCharge)); if (!data || data.length < 500) break; }
    return NextResponse.json(buildRentDueSummary(charges, period));
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Could not read rent due." }, { status: 500 }); }
}
