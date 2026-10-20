import { NextResponse } from "next/server";
import { financeErrorResponse, requireManagedOwner } from "@/lib/managed-finance/routes.server";
import { signPolicy } from "@/lib/owner-management/policies.server";
import { presentPolicy } from "@/lib/owner-management/policies-api.server";

export const runtime = "nodejs";

/**
 * POST: the signed-in owner of record signs the agreement they were sent. The owner is the session; the body
 * carries only `termsSha256`, the hash of the terms the page rendered, which the server re-derives and checks.
 */
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const ctx = await requireManagedOwner();
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await context.params;
  const body = (await req.json().catch(() => null)) as { termsSha256?: unknown } | null;
  const termsSha256 = typeof body?.termsSha256 === "string" ? body.termsSha256 : "";
  try {
    return NextResponse.json({ policy: presentPolicy(await signPolicy(ctx.db, ctx.userId, id, termsSha256)) });
  } catch (e) {
    return financeErrorResponse(e, "Could not record your signature.");
  }
}
