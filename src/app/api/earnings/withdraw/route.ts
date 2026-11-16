import { NextResponse } from "next/server";
import { getStripe } from "@/lib/stripe";
import { financeErrorResponse, requireEarningsPerson } from "@/lib/managed-finance/routes.server";
import { resolveManagedPayee } from "@/lib/managed-finance/payee.server";
import { listPoliciesForWorkspace } from "@/lib/owner-management/policies.server";
import { noteOwnerWithdrawal, withdrawFromManagedFunds } from "@/lib/managed-finance/withdrawals.server";

export const runtime = "nodejs";

/**
 * POST { scope: "owner" | "vendor", workspaceId?, amountCents, clientKey }: withdraw the signed-in person's own available balance to
 * their own Express account. The person is the session. For `owner` the workspace is proven inside the withdrawal (a fee policy
 * naming them, or a payout split paying them); the ledger's own figure, the per-party lock and any staff hold decide the rest.
 */
export async function POST(req: Request) {
  const ctx = await requireEarningsPerson();
  if (ctx instanceof NextResponse) return ctx;
  let body: { scope?: unknown; workspaceId?: unknown; amountCents?: unknown; clientKey?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const kind = body.scope === "vendor" ? "vendor" : body.scope === "owner" ? "owner" : null;
  const amountCents = typeof body.amountCents === "number" ? body.amountCents : NaN;
  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
  if (!kind) return NextResponse.json({ error: "Choose what to withdraw." }, { status: 400 });
  try {
    if (kind === "owner" && workspaceId) {
      // A fee policy that names the person is not enough once the payee seat has moved on: the owner of record is the payee.
      const policies = await listPoliciesForWorkspace(ctx.db, workspaceId);
      if (policies.some((p) => p.ownerUserId === ctx.userId) && (await resolveManagedPayee(ctx.db, workspaceId)) !== ctx.userId) {
        return NextResponse.json({ error: "Not found." }, { status: 403 });
      }
    }
    const result = await withdrawFromManagedFunds(getStripe(), ctx.db, {
      kind, userId: ctx.userId, workspaceId: kind === "owner" ? workspaceId : null, amountCents,
      clientKey: typeof body.clientKey === "string" ? body.clientKey.slice(0, 80) : undefined,
    });
    if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
    if (kind === "owner" && workspaceId) await noteOwnerWithdrawal(ctx.db, { workspaceId, amountCents, withdrawalId: result.withdrawalId }).catch(() => undefined);
    return NextResponse.json({
      ok: true, withdrawalId: result.withdrawalId, payoutPending: result.payoutPending,
      payoutAutomatic: result.payoutAutomatic === true, payoutScheduleUnknown: result.payoutScheduleUnknown === true,
    });
  } catch (e) {
    return financeErrorResponse(e, "Could not start the withdrawal.");
  }
}
