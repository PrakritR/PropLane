import { NextResponse } from "next/server";
import { setOwnerRepairThreshold } from "@/lib/owner-management/agreements.server";
import { agreementErrorResponse, presentAgreement } from "@/lib/owner-management/agreements-api.server";
import { requireOwnerRoute } from "@/lib/property-owner/route-auth.server";

export const runtime = "nodejs";

/** PATCH { repairApprovalThresholdCents }: the owner's own "approve routine repairs under $X" setting. */
export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const ctx = await requireOwnerRoute();
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await context.params;
  let body: { repairApprovalThresholdCents?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const cents = typeof body.repairApprovalThresholdCents === "number" ? body.repairApprovalThresholdCents : NaN;
  try {
    const row = await setOwnerRepairThreshold(ctx.db, ctx.userId, id, cents);
    return NextResponse.json({ agreement: presentAgreement(row, "", null) });
  } catch (e) {
    return agreementErrorResponse(e, "Could not save.");
  }
}
