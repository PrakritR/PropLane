import { NextResponse } from "next/server";
import { requireVendorApiAccess } from "@/lib/auth/vendor-api-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripe";
import { stripePayoutErrorResponse } from "@/lib/stripe-payouts.server";
import { vendorBankingEnabled, vendorRefundsEnabled } from "@/lib/vendor-banking/flag";
import { readVendorRefundFunds, submitVendorRefund } from "@/lib/vendor-banking/central-refund.server";
import { getVendorBankingPayoutForVendor } from "@/lib/vendor-banking/payouts.server";
import { computeVendorRefundCap, remainingRefundableGrossCents } from "@/lib/vendor-banking/refund-cap";
import { track } from "@/lib/analytics/posthog";

export const runtime = "nodejs";

/**
 * What the Refund a payment pop-up needs: the payment's own figures and the cap the server
 * computes from the central rail's held/released split. Scoped to the signed-in vendor.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    if (!vendorBankingEnabled()) return NextResponse.json({ error: "Vendor banking is not enabled." }, { status: 404 });
    const access = await requireVendorApiAccess();
    if (!access.ok) {
      return NextResponse.json({ error: access.status === 401 ? "Unauthorized." : "Forbidden." }, { status: access.status });
    }
    const { id } = await ctx.params;
    const db = createSupabaseServiceRoleClient();
    const payout = await getVendorBankingPayoutForVendor(db, { payoutId: id, vendorUserId: access.actor.userId });
    if (!payout) return NextResponse.json({ error: "Payment not found." }, { status: 404 });
    const base = {
      enabled: vendorRefundsEnabled(),
      payoutId: payout.id,
      amountCents: payout.amountCents,
      platformFeeCents: payout.platformFeeCents,
      refundedGrossCents: payout.refundedGrossCents,
    };
    if (!vendorRefundsEnabled() || (payout.status !== "paid" && payout.status !== "partially_refunded")) {
      return NextResponse.json({ ...base, maxGrossCents: 0, refusal: null });
    }
    if (payout.destination !== "hold") {
      return NextResponse.json({ ...base, maxGrossCents: remainingRefundableGrossCents(payout), refusal: null });
    }
    const { data: holdRow } = await db.from("vendor_payouts").select("platform_hold_id").eq("id", payout.id).eq("vendor_user_id", access.actor.userId).maybeSingle();
    const holdId = (holdRow as { platform_hold_id?: string | null } | null)?.platform_hold_id;
    if (!holdId) return NextResponse.json({ ...base, maxGrossCents: 0, refusal: "withdrawn" });
    const funds = await readVendorRefundFunds(getStripe(), db, { vendorUserId: access.actor.userId, holdId });
    const cap = computeVendorRefundCap(payout, funds);
    return NextResponse.json({ ...base, maxGrossCents: cap.maxGrossCents, refusal: cap.refusal });
  } catch (e) {
    return stripePayoutErrorResponse("vendor/payouts/[id]/refund GET", e);
  }
}

/**
 * Vendor-initiated refund of a payment they own, on the central refund rail
 * (`runReservedPlatformMoneyRefund`). Ownership is derived from the signed-in vendor, never
 * trusted from the body or the id: a vendor can only ever resolve `vendor_payouts` rows where
 * `vendor_user_id` is their own id, so vendor A can never refund vendor B's payment (404).
 * Amounts are recomputed server-side; the body carries only the gross amount asked for and a
 * reason. The `Idempotency-Key` header is required and makes a retry or double-submit replay
 * one reservation. Stays behind `VENDOR_REFUNDS_ENABLED` (default off until Stripe TEST proof).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    if (!vendorBankingEnabled()) {
      return NextResponse.json({ error: "Vendor banking is not enabled." }, { status: 404 });
    }
    // Off by default until the central-rail path is proven against Stripe TEST. Fail closed
    // before any Stripe call.
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
    if (amountCents !== undefined && (!Number.isSafeInteger(amountCents) || amountCents <= 0)) {
      return NextResponse.json({ error: "amountCents must be a positive whole number." }, { status: 400 });
    }
    const reason = typeof body.reason === "string" ? body.reason.slice(0, 500) : undefined;
    const clientKey = req.headers.get("Idempotency-Key")?.trim() ?? "";

    const db = createSupabaseServiceRoleClient();
    const stripe = getStripe();
    const result = await submitVendorRefund(stripe, db, {
      payoutId: id,
      vendorUserId: access.actor.userId,
      requestedGrossCents: amountCents,
      reason,
      clientKey,
    });
    if (!result.ok) return NextResponse.json({ code: result.code, error: result.error }, { status: result.status });

    track("vendor_payout_refunded", access.actor.userId, {
      payout_id: id,
      requested_gross_cents: result.grossCents,
      fee_share_cents: result.feeShareCents,
      net_debit_cents: result.netDebitCents,
      status: result.status,
      replay: result.replay,
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
