import { NextResponse } from "next/server";
import { reinstateLeaseFee } from "@/lib/lease-fee-waiver.server";
import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";

export const runtime = "nodejs";

/**
 * PATCH - remove a waiver (`{ action: "revoke" }`): the lease fee is owed again. `id` is the lease id,
 * scoped to leases the signed-in manager can edit, so a manager can never touch - or discover - another
 * manager's waiver.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireManagerRouteUser();
  if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { action?: string };
  if (body.action !== "revoke") {
    return NextResponse.json({ error: "Unsupported action." }, { status: 400 });
  }
  const result = await reinstateLeaseFee(ctx.db, { managerUserId: ctx.userId, leaseId: id });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, applicationIds: result.applicationIds, reinstatedChargeIds: result.reinstatedChargeIds });
}
