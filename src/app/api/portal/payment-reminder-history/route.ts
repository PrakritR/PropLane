import { NextResponse } from "next/server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";
import { loadPaymentReminderChargeForActor } from "@/lib/payment-reminder-capability.server";
import { loadPaymentReminderHistory } from "@/lib/payment-reminder-history.server";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "private, no-store" };

export async function GET(req: Request) {
  try {
    const actor = await requireManagerRouteUser();
    if (!actor) return NextResponse.json({ error: "Unauthorized." }, { status: 403, headers: NO_STORE });
    const url = new URL(req.url);
    const chargeId = url.searchParams.get("chargeId")?.trim() ?? "";
    const occurrenceId = url.searchParams.get("occurrenceId")?.trim() || undefined;
    if (!chargeId || chargeId.length > 200 || (occurrenceId && occurrenceId.length > 300)) {
      return NextResponse.json({ error: "A valid chargeId is required." }, { status: 400, headers: NO_STORE });
    }

    const admin = await isAdminUser(actor.userId);
    const context = await loadPaymentReminderChargeForActor(actor.db, actor.userId, chargeId, admin);
    if (!context) return NextResponse.json({ error: "Charge not found." }, { status: 404, headers: NO_STORE });

    const occurrences = await loadPaymentReminderHistory({
      db: actor.db,
      actorUserId: actor.userId,
      ownerUserId: context.ownerUserId,
      chargeId,
      admin,
      occurrenceId,
    });
    return NextResponse.json({
      chargeId,
      ownerUserId: context.ownerUserId,
      checkedAt: new Date().toISOString(),
      occurrences,
    }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "Could not load reminder history." }, { status: 503, headers: NO_STORE });
  }
}
