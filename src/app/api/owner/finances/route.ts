import { NextResponse } from "next/server";
import { loadOwnerFinances } from "@/lib/managed-finance/finances.server";
import { financeErrorResponse, requireManagedOwner, stripeOrNull } from "@/lib/managed-finance/routes.server";
import { describeManagedFee } from "@/lib/owner-management/fee-math";

export const runtime = "nodejs";

/**
 * GET: with no workspace, the person's managed workspaces. With `?workspace=<id>[&month=YYYY-MM]`, that workspace's balance,
 * statement, withdrawals and repair approvals. The workspace is proven by the owner-of-record lookup inside the loader; an
 * unknown or someone else's is a 404. There is no signing step anywhere here: the management fee is PropLane's own rate.
 */
export async function GET(req: Request) {
  const ctx = await requireManagedOwner();
  if (ctx instanceof NextResponse) return ctx;
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspace")?.trim() ?? "";
  try {
    if (!workspaceId) {
      return NextResponse.json({
        workspaces: ctx.workspaces.map((w) => ({ id: w.workspaceId, name: w.workspaceName, status: w.status, feeLine: describeManagedFee(w.terms) })),
      });
    }
    const view = await loadOwnerFinances(ctx.db, stripeOrNull(), { ownerUserId: ctx.userId, workspaceId, month: url.searchParams.get("month") });
    return NextResponse.json(view);
  } catch (e) {
    return financeErrorResponse(e, "Could not load your finances.");
  }
}
