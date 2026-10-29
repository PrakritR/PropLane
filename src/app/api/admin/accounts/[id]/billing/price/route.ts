import { NextResponse } from "next/server";
import { changeAccountPrice } from "@/lib/admin/admin-billing-money-actions.server";
import { resolveAdminBillingTarget } from "@/lib/admin/admin-account-billing-route.server";

export const runtime = "nodejs";

/**
 * POST /api/admin/accounts/[id]/billing/price — `{ monthlyCents: number | "rate-card", reason }`.
 * Overall admin only; reason required before any Stripe call; audit row first; applies from the next invoice.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const resolved = await resolveAdminBillingTarget(req, ctx);
    if (!resolved.ok) return resolved.response;
    const { db, actorUserId, managerUserId, body } = resolved.target;
    const result = await changeAccountPrice({ db, actorUserId, managerUserId, reason: body.reason }, body.monthlyCents);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ ok: true, monthlyCents: result.monthlyCents, rateCard: result.rateCard, effective: result.effective });
  } catch (e) {
    console.error("POST /api/admin/accounts/[id]/billing/price failed", e);
    return NextResponse.json({ error: "Could not change the price." }, { status: 500 });
  }
}
