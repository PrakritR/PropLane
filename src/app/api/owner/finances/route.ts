import { NextResponse } from "next/server";
import { loadOwnerFinances } from "@/lib/managed-finance/finances.server";
import { financeErrorResponse, requireManagedOwner, stripeOrNull } from "@/lib/managed-finance/routes.server";
import { describeManagedFee } from "@/lib/owner-management/fee-math";
import { loadPolicy, policyTermsHash } from "@/lib/owner-management/policies.server";

export const runtime = "nodejs";

/**
 * GET: with no workspace, the person's managed workspaces and any agreement waiting for their signature. With
 * `?workspace=<id>[&month=YYYY-MM]`, that workspace's balance, statement, withdrawals and repair approvals. The workspace is
 * proven by the owner-of-record lookup inside the loader; an unknown or someone else's is a 404.
 */
export async function GET(req: Request) {
  const ctx = await requireManagedOwner();
  if (ctx instanceof NextResponse) return ctx;
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspace")?.trim() ?? "";
  try {
    if (!workspaceId) {
      const waiting = [];
      for (const id of ctx.waitingPolicyIds) {
        const p = await loadPolicy(ctx.db, id);
        if (p && p.ownerUserId === ctx.userId && p.status === "draft" && p.sentAt) {
          waiting.push({
            id: p.id, workspaceId: p.workspaceId, feeLine: describeManagedFee(p.terms), terms: p.terms,
            effectiveFrom: p.effectiveFrom,
            // The owner signs THESE terms: the client echoes the hash back and the sign route refuses a mismatch.
            termsSha256: policyTermsHash(p),
          });
        }
      }
      return NextResponse.json({
        workspaces: ctx.workspaces.map((w) => ({ id: w.workspaceId, name: w.workspaceName, status: w.status, feeLine: describeManagedFee(w.terms) })),
        waiting,
      });
    }
    const view = await loadOwnerFinances(ctx.db, stripeOrNull(), { ownerUserId: ctx.userId, workspaceId, month: url.searchParams.get("month") });
    return NextResponse.json(view);
  } catch (e) {
    return financeErrorResponse(e, "Could not load your finances.");
  }
}
