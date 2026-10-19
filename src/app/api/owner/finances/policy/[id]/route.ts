import { NextResponse } from "next/server";
import { financeErrorResponse, requireManagedOwner } from "@/lib/managed-finance/routes.server";
import { setOwnerPreferences } from "@/lib/owner-management/policies.server";
import { presentPolicy } from "@/lib/owner-management/policies-api.server";

export const runtime = "nodejs";

/** PATCH { repairApprovalThresholdCents?, reserveTargetCents? }: the owner's own preferences, editable after signing. */
export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const ctx = await requireManagedOwner();
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await context.params;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const num = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) ? v : undefined);
  try {
    const row = await setOwnerPreferences(ctx.db, ctx.userId, id, {
      repairApprovalThresholdCents: num(body.repairApprovalThresholdCents),
      reserveTargetCents: num(body.reserveTargetCents),
    });
    return NextResponse.json({ policy: presentPolicy(row) });
  } catch (e) {
    return financeErrorResponse(e, "Could not save.");
  }
}
