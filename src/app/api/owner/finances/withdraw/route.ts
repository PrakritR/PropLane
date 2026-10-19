import { NextResponse } from "next/server";
import { getStripe } from "@/lib/stripe";
import { financeErrorResponse, requireManagedOwner } from "@/lib/managed-finance/routes.server";
import { noteOwnerWithdrawal, withdrawFromManagedFunds } from "@/lib/managed-finance/withdrawals.server";

export const runtime = "nodejs";

/** POST { workspaceId, amountCents, clientKey }: withdraw available balance to the owner's own Express account. */
export async function POST(req: Request) {
  const ctx = await requireManagedOwner();
  if (ctx instanceof NextResponse) return ctx;
  let body: { workspaceId?: unknown; amountCents?: unknown; clientKey?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const amountCents = typeof body.amountCents === "number" ? body.amountCents : NaN;
  try {
    const result = await withdrawFromManagedFunds(getStripe(), ctx.db, {
      kind: "owner",
      userId: ctx.userId,
      workspaceId: typeof body.workspaceId === "string" ? body.workspaceId : null,
      amountCents,
      clientKey: typeof body.clientKey === "string" ? body.clientKey.slice(0, 80) : undefined,
    });
    if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
    await noteOwnerWithdrawal(ctx.db, { workspaceId: String(body.workspaceId), amountCents, withdrawalId: result.withdrawalId }).catch(() => undefined);
    return NextResponse.json({ ok: true, withdrawalId: result.withdrawalId, payoutPending: result.payoutPending });
  } catch (e) {
    return financeErrorResponse(e, "Could not start the withdrawal.");
  }
}
