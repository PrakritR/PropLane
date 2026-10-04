import { NextResponse } from "next/server";
import {
  assertPropertiesOwnedByManager,
  revokeApplicationFeeWaiverCode,
  updateApplicationFeeWaiverCode,
  type UpdateWaiverCodeInput,
} from "@/lib/application-fee-waiver";
import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";

export const runtime = "nodejs";

type PatchBody = {
  action?: string;
  appliesTo?: string;
  propertyIds?: string[];
  maxUses?: number | null;
  expiresAt?: string | null;
  label?: string | null;
};

/**
 * PATCH - `{ action: "revoke" }` disables a waiver code; `{ action: "update", ... }` edits an active one
 * (what it applies to, its property limit, use cap, expiry, label). Both are scoped to the signed-in
 * manager's OWN codes (the lib filters on `manager_user_id`), so a manager can never change - or discover
 * the existence of - another manager's code.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireManagerRouteUser();
  if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as PatchBody;

  if (body.action === "revoke") {
    const result = await revokeApplicationFeeWaiverCode(ctx.db, ctx.userId, id);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 404 });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "update") {
    const input: UpdateWaiverCodeInput = {};
    if ("appliesTo" in body) input.appliesTo = body.appliesTo as UpdateWaiverCodeInput["appliesTo"];
    if ("propertyIds" in body) {
      input.propertyIds = Array.isArray(body.propertyIds) ? body.propertyIds.map(String) : [];
      const owned = await assertPropertiesOwnedByManager(ctx.db, ctx.userId, input.propertyIds);
      if (!owned.ok) return NextResponse.json({ error: owned.error }, { status: 400 });
    }
    if ("maxUses" in body) input.maxUses = body.maxUses ?? null;
    if ("expiresAt" in body) input.expiresAt = body.expiresAt ?? null;
    if ("label" in body) input.label = body.label ?? null;
    const result = await updateApplicationFeeWaiverCode(ctx.db, ctx.userId, id, input);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ code: result.code });
  }

  return NextResponse.json({ error: "Unsupported action." }, { status: 400 });
}
