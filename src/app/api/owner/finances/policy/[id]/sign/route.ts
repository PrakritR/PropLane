import { NextResponse } from "next/server";
import { financeErrorResponse, requireManagedOwner } from "@/lib/managed-finance/routes.server";
import { signPolicy } from "@/lib/owner-management/policies.server";
import { presentPolicy } from "@/lib/owner-management/policies-api.server";

export const runtime = "nodejs";

/** POST: the signed-in owner of record signs the agreement they were sent. No body: the owner is the session. */
export async function POST(_req: Request, context: { params: Promise<{ id: string }> }) {
  const ctx = await requireManagedOwner();
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await context.params;
  try {
    return NextResponse.json({ policy: presentPolicy(await signPolicy(ctx.db, ctx.userId, id)) });
  } catch (e) {
    return financeErrorResponse(e, "Could not record your signature.");
  }
}
