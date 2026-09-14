import { NextResponse } from "next/server";
import { loadFormalDocumentScopeOptions } from "@/lib/reports/formal-documents/scoped-queries";
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
    const propertyId = url.searchParams.get("propertyId") || undefined;
    const options = await loadFormalDocumentScopeOptions(
      auth.db,
      auth.userId,
      propertyId,
      // The pickers only offer houses the active workspace holds.
      await activeWorkspacePropertyScope(auth.db, auth.userId),
    );
    return NextResponse.json(options);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
