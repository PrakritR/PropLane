import { NextResponse } from "next/server";
import { signAgreement } from "@/lib/owner-management/agreements.server";
import { agreementErrorResponse, presentAgreement } from "@/lib/owner-management/agreements-api.server";
import { requireOwnerRoute } from "@/lib/property-owner/route-auth.server";

export const runtime = "nodejs";

/** POST: the signed-in owner signs the agreement they were sent. No body: the owner is the session. */
export async function POST(_req: Request, context: { params: Promise<{ id: string }> }) {
  const ctx = await requireOwnerRoute();
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await context.params;
  try {
    const row = await signAgreement(ctx.db, ctx.userId, id);
    return NextResponse.json({ agreement: presentAgreement(row, "", null) });
  } catch (e) {
    return agreementErrorResponse(e, "Could not record your signature.");
  }
}
