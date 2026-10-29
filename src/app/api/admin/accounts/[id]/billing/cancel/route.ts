import { NextResponse } from "next/server";
import { cancelAccountSubscription } from "@/lib/admin/admin-billing-money-actions.server";
import { resolveAdminBillingTarget } from "@/lib/admin/admin-account-billing-route.server";

export const runtime = "nodejs";

/**
 * POST /api/admin/accounts/[id]/billing/cancel — `{ when: "period_end" | "now", reason }`.
 * Overall admin only; reason required before any Stripe call; audit row first.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const resolved = await resolveAdminBillingTarget(req, ctx);
    if (!resolved.ok) return resolved.response;
    const { db, actorUserId, managerUserId, body } = resolved.target;
    const result = await cancelAccountSubscription({ db, actorUserId, managerUserId, reason: body.reason }, body.when);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ ok: true, when: result.when, endsAt: result.endsAt });
  } catch (e) {
    console.error("POST /api/admin/accounts/[id]/billing/cancel failed", e);
    return NextResponse.json({ error: "Could not cancel the subscription." }, { status: 500 });
  }
}
