import { NextResponse } from "next/server";
import {
  assertManagerFinancialsAccess,
  getReportsAuthContext,
} from "@/lib/reports/auth";
import { listSecurityDeposits } from "@/lib/reports/security-deposits";
import { activeWorkspacePropertyScope } from "@/lib/workspaces/scope.server";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const auth = await getReportsAuthContext({ preferRole: "manager" });
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const gate = await assertManagerFinancialsAccess(auth);
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

    const { searchParams } = new URL(req.url);
    const propertyId = searchParams.get("propertyId")?.trim() || undefined;
    const status = searchParams.get("status")?.trim() as
      | "held"
      | "partially_refunded"
      | "refunded"
      | "forfeited"
      | "applied_to_damages"
      | undefined;

    // The active workspace narrows this list exactly as it narrows the Money overview's "Held deposits"
    // tile (the financial-activity report), so the two can never disagree about which houses count.
    const workspacePropertyIds = await activeWorkspacePropertyScope(auth.db, auth.userId);
    const deposits = await listSecurityDeposits(auth.db, auth.userId, { propertyId, status, workspacePropertyIds });
    return NextResponse.json({ deposits });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to list deposits.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
