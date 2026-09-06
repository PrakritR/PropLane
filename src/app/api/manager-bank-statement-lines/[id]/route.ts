import { NextResponse } from "next/server";
import { assertManagerFinancialsAccess, getReportsAuthContext } from "@/lib/reports/auth";
import { reconcileBankStatementLine } from "@/lib/manager-bank-reconciliation.server";
import { track } from "@/lib/analytics/posthog";

export const runtime = "nodejs";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const auth = await getReportsAuthContext({ preferRole: "manager" });
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const gate = await assertManagerFinancialsAccess(auth);
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

    const { id } = await ctx.params;
    const body = (await req.json()) as { matchedLedgerEntryId?: string | null; matchedExpenseEntryId?: string | null; cleared?: boolean };
    const line = await reconcileBankStatementLine(auth.db, auth.userId, id, {
      matchedLedgerEntryId: body.matchedLedgerEntryId,
      matchedExpenseEntryId: body.matchedExpenseEntryId,
      cleared: body.cleared,
    });
    track("bank_statement_line_matched", auth.userId, { lineId: line.id, cleared: line.cleared });
    return NextResponse.json({ line });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Reconcile failed." }, { status: 500 });
  }
}
