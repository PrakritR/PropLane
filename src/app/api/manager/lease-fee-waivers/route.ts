import { NextResponse } from "next/server";
import { listLeaseFeeWaivers, waiveLeaseFee } from "@/lib/lease-fee-waiver.server";
import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";

export const runtime = "nodejs";

/** GET - this manager's OWN waived lease fees. Never another manager's. */
export async function GET() {
  const ctx = await requireManagerRouteUser();
  if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    return NextResponse.json({ waivers: await listLeaseFeeWaivers(ctx.db, ctx.userId) });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not load waived lease fees.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

type WaiveBody = { leaseId?: string; reason?: string };

/**
 * POST - waive the lease fee for ONE lease the signed-in manager can edit. The fee is not charged and drops
 * out of the at-signing total; refused (409) once it has been paid.
 */
export async function POST(req: Request) {
  const ctx = await requireManagerRouteUser();
  if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as WaiveBody;
  const result = await waiveLeaseFee(ctx.db, {
    managerUserId: ctx.userId,
    leaseId: String(body.leaseId ?? ""),
    reason: body.reason,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({
    waiver: result.waiver,
    applicationIds: result.applicationIds,
    cancelledChargeIds: result.cancelledChargeIds,
  });
}
