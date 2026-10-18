import { NextResponse } from "next/server";
import { financeErrorResponse, requireManagedOwner } from "@/lib/managed-finance/routes.server";
import { decideOwnerExpense } from "@/lib/managed-finance/vendor-bills.server";

export const runtime = "nodejs";

/** POST { approve: boolean }: the owner's yes or no on a repair. The owner is the session; the expense must be theirs. */
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const ctx = await requireManagedOwner();
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await context.params;
  let body: { approve?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  if (typeof body.approve !== "boolean") return NextResponse.json({ error: "approve must be true or false." }, { status: 400 });
  try {
    const result = await decideOwnerExpense(ctx.db, { expenseId: id, ownerUserId: ctx.userId, approve: body.approve, via: "portal" });
    if (result.status === "not_found") return NextResponse.json({ error: "Not found." }, { status: 404 });
    return NextResponse.json({ status: result.status });
  } catch (e) {
    return financeErrorResponse(e, "Could not record your answer.");
  }
}
