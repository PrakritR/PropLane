import { NextResponse } from "next/server";
import { financeErrorResponse, requireManagedOwner } from "@/lib/managed-finance/routes.server";
import { approveRoutineExpenses } from "@/lib/managed-finance/vendor-bills.server";
import { listManagedWorkspacesForOwner, setOwnerPreferences } from "@/lib/owner-management/policies.server";

export const runtime = "nodejs";

/**
 * POST { workspaceId, capCents }: approve every waiting repair at or under the amount AND make that amount the owner's new
 * automatic-approval amount ("approve all routine repairs under $X"). Both writes are scoped to the owner of record.
 */
export async function POST(req: Request) {
  const ctx = await requireManagedOwner();
  if (ctx instanceof NextResponse) return ctx;
  let body: { workspaceId?: unknown; capCents?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const capCents = typeof body.capCents === "number" ? body.capCents : NaN;
  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
  try {
    const mine = (await listManagedWorkspacesForOwner(ctx.db, ctx.userId)).find((w) => w.workspaceId === workspaceId && w.status === "active");
    if (!mine) return NextResponse.json({ error: "Not found." }, { status: 404 });
    await setOwnerPreferences(ctx.db, ctx.userId, mine.policyId, { repairApprovalThresholdCents: capCents });
    const approved = await approveRoutineExpenses(ctx.db, ctx.userId, workspaceId, capCents);
    return NextResponse.json({ approved });
  } catch (e) {
    return financeErrorResponse(e, "Could not save.");
  }
}
