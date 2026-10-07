import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { requireVendorApiAccess } from "@/lib/auth/vendor-api-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripe";
import { stripePayoutErrorResponse } from "@/lib/stripe-payouts.server";
import { vendorBankingEnabled, vendorRefundsEnabled } from "@/lib/vendor-banking/flag";
import { refundVendorPayout } from "@/lib/vendor-banking/refund.server";
import { track } from "@/lib/analytics/posthog";

export const runtime = "nodejs";

/**
 * Vendor-initiated refund of a payment they own. Ownership is derived from
 * the signed-in vendor, never trusted from the body — a vendor can only ever
 * see and refund `vendor_payouts` rows where `vendor_user_id` is their own
 * id, so vendor A can never refund vendor B's payment (404, not 403 — the
 * row simply doesn't resolve for them).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    if (!vendorBankingEnabled()) {
      return NextResponse.json({ error: "Vendor banking is not enabled." }, { status: 404 });
    }
    // Paused until the refund is rebuilt on the central refund rail
    // (runReservedPlatformMoneyRefund): this direct path refunds a central
    // 'hold' capture without platform_refund_attempt metadata, which the
    // webhook refuses and which wedges the hold (financials.md: no fourth
    // refund path). Fail closed before any Stripe call.
    if (!vendorRefundsEnabled()) {
      return NextResponse.json(
        { code: "VENDOR_REFUND_PAUSED", error: "Refunds to managers are being upgraded. Message the manager for now." },
        { status: 409 },
      );
    }
    const access = await requireVendorApiAccess();
    if (!access.ok) {
      return NextResponse.json(
        { error: access.status === 401 ? "Unauthorized." : "Forbidden." },
        { status: access.status },
      );
    }
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as { amountCents?: unknown; reason?: unknown };
    const amountCents = body.amountCents === undefined ? undefined : Number(body.amountCents);
    if (amountCents !== undefined && (!Number.isFinite(amountCents) || amountCents <= 0)) {
      return NextResponse.json({ error: "amountCents must be a positive number." }, { status: 400 });
    }
    const reason = typeof body.reason === "string" ? body.reason.slice(0, 500) : undefined;
    const idempotencyKey = req.headers.get("Idempotency-Key")?.trim() || randomUUID();

    const db = createSupabaseServiceRoleClient();
    const stripe = getStripe();
    const result = await refundVendorPayout(stripe, db, {
      payoutId: id,
      vendorUserId: access.actor.userId,
      requestedGrossCents: amountCents,
      reason,
      idempotencyKey,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

    track("vendor_payout_refunded", access.actor.userId, {
      payout_id: id,
      requested_gross_cents: result.requestedGrossCents,
      fee_share_cents: result.feeShareCents,
      net_debit_cents: result.netDebitCents,
      shortfall_cents: result.shortfallCents,
    });
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Stripe error";
    if (msg.includes("STRIPE_SECRET_KEY") || msg.includes("Missing STRIPE")) {
      return NextResponse.json(
        { code: "STRIPE_NOT_CONFIGURED", error: "Stripe is not configured (missing STRIPE_SECRET_KEY)." },
        { status: 503 },
      );
    }
    return stripePayoutErrorResponse("vendor/payouts/[id]/refund POST", e);
  }
}
