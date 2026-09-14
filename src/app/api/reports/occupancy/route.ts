import { NextResponse } from "next/server";
import { applyFormalDocumentScope, queryOccupancyReport } from "@/lib/reports/formal-documents/scoped-queries";
import type { DocumentScope } from "@/lib/reports/types";
import { assertManagerFinancialsAccess, getReportsAuthContext } from "@/lib/reports/auth";
import { activeWorkspacePropertyScope } from "@/lib/workspaces/scope.server";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const auth = await getReportsAuthContext({ preferRole: "manager" });
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const gate = await assertManagerFinancialsAccess(auth);
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

    const url = new URL(req.url);
    const scope = (url.searchParams.get("scope") || "portfolio") as DocumentScope;
    const filters = applyFormalDocumentScope({
      // The viewer's active workspace, read server-side from their own
      // selection, narrows the report before it touches the ledger.
      workspacePropertyIds: await activeWorkspacePropertyScope(auth.db, auth.userId),
      scope,
      propertyId: url.searchParams.get("propertyId") || undefined,
      from: url.searchParams.get("from") || undefined,
      to: url.searchParams.get("to") || undefined,
    });

    const report = await queryOccupancyReport(auth.db, auth.userId, filters);
    return NextResponse.json(report);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
