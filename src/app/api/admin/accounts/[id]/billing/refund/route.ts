import { NextResponse } from "next/server";
import { refundAccountInvoice } from "@/lib/admin/admin-billing-money-actions.server";
import { resolveAdminBillingTarget } from "@/lib/admin/admin-account-billing-route.server";

export const runtime = "nodejs";

/**
 * POST /api/admin/accounts/[id]/billing/refund — `{ invoiceId, amountCents, nonce, reason }`.
 * Overall admin only; reason required before any Stripe call; audit row first. The refundable
 * amount is re-read from Stripe here, never taken from the client.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const resolved = await resolveAdminBillingTarget(req, ctx);
    if (!resolved.ok) return resolved.response;
    const { db, actorUserId, managerUserId, body } = resolved.target;
    const result = await refundAccountInvoice(
      { db, actorUserId, managerUserId, reason: body.reason },
      { invoiceId: body.invoiceId, amountCents: body.amountCents, nonce: body.nonce },
    );
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({
      ok: true,
      refundId: result.refundId,
      status: result.status,
      amountCents: result.amountCents,
      remainingRefundableCents: result.remainingRefundableCents,
    });
  } catch (e) {
    console.error("POST /api/admin/accounts/[id]/billing/refund failed", e);
    return NextResponse.json({ error: "Could not refund that invoice." }, { status: 500 });
  }
}
