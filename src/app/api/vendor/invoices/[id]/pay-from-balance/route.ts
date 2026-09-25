import { NextResponse } from "next/server";
import { assertManagerFinancialsAccess, getReportsAuthContext } from "@/lib/reports/auth";
import { proplaneBalanceEnabled } from "@/lib/proplane-balance/flag";
import { payVendorFromBalance } from "@/lib/proplane-balance/ledger.server";
import { canTransitionVendorInvoice, mapVendorInvoiceRow, VENDOR_INVOICE_SELECT, type VendorInvoiceStatus } from "@/lib/vendor-invoices";
import { findBlockingVendorPayout } from "@/lib/work-order-approve-pay.server";
import { track } from "@/lib/analytics/posthog";

export const runtime = "nodejs";

/**
 * "Pay from PropLane balance" — moves the invoice total from the manager's
 * workspace balance to the vendor's balance instantly, inside the ledger, and
 * marks the invoice paid (`paid_from: "balance"`). No Stripe call. Reuses the
 * SAME double-pay guard `approve-pay` uses (`findBlockingVendorPayout`) when
 * the invoice is tied to a work order that already has a `vendor_payouts`
 * row — a manager cannot pay the same job twice through two different rails.
 * Insufficient balance answers 422 with the shortfall; the client falls back
 * to the existing card-funded Approve + Pay path.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    if (!proplaneBalanceEnabled()) {
      return NextResponse.json({ error: "The PropLane balance is not enabled." }, { status: 404 });
    }
    const { id } = await ctx.params;
    const auth = await getReportsAuthContext({ preferRole: "manager" });
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const gate = await assertManagerFinancialsAccess(auth);
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

    const { data: existing, error: readError } = await auth.db
      .from("vendor_invoices")
      .select("id, status, vendor_user_id, total_cents, work_order_id, bill_id")
      .eq("id", id)
      .eq("manager_user_id", auth.userId)
      .maybeSingle();
    if (readError) return NextResponse.json({ error: readError.message }, { status: 500 });
    if (!existing) return NextResponse.json({ error: "Invoice not found." }, { status: 404 });

    const currentStatus = existing.status as VendorInvoiceStatus;
    if (!canTransitionVendorInvoice(currentStatus, "paid")) {
      return NextResponse.json({ error: `Invoice is ${currentStatus}; it cannot be paid.` }, { status: 409 });
    }
    const totalCents = Number(existing.total_cents ?? 0);
    if (totalCents < 100) {
      return NextResponse.json({ error: "Invoice total must be at least $1.00." }, { status: 400 });
    }
    const vendorUserId = String(existing.vendor_user_id ?? "").trim();
    if (!vendorUserId) return NextResponse.json({ error: "Invoice has no vendor." }, { status: 400 });

    const workOrderId = (existing.work_order_id as string | null)?.trim();
    if (workOrderId) {
      const blocking = await findBlockingVendorPayout(auth.db, workOrderId);
      if (!blocking.ok) return NextResponse.json({ error: blocking.error }, { status: 500 });
      if (blocking.payout) {
        return NextResponse.json(
          { error: "This job already has a PropLane payout on record — reload and check its status." },
          { status: 409 },
        );
      }
    }

    const move = await payVendorFromBalance(auth.db, {
      managerUserId: auth.userId,
      vendorUserId,
      amountCents: totalCents,
      idempotencyRoot: `vendor-invoice:${id}`,
    });
    if (!move.ok) {
      if (move.code === "insufficient_balance") {
        return NextResponse.json(
          {
            error: `The PropLane balance has ${(move.availableCents / 100).toFixed(2)} available; this invoice needs ${(move.requestedCents / 100).toFixed(2)}.`,
            code: "insufficient_balance",
            availableCents: move.availableCents,
            requestedCents: move.requestedCents,
            shortfallCents: move.shortfallCents,
          },
          { status: 422 },
        );
      }
      return NextResponse.json({ error: move.error }, { status: 500 });
    }

    const now = new Date().toISOString();
    // Same compare-and-swap the decision route uses: only a caller that still
    // sees the pre-move status can land the write, so a race loses cleanly
    // rather than double-marking paid (the ledger move itself is already
    // idempotent on the invoice id, so a genuine retry after this point is
    // harmless — but a second DIFFERENT request racing the first is not).
    const { data, error } = await auth.db
      .from("vendor_invoices")
      .update({ status: "paid", paid_at: now, paid_from: "balance", decided_at: now, decided_by: auth.userId, updated_at: now })
      .eq("id", id)
      .eq("manager_user_id", auth.userId)
      .eq("status", currentStatus)
      .select(VENDOR_INVOICE_SELECT)
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data) {
      // The ledger move already landed (idempotent on `vendor-invoice:<id>`),
      // so this is a lost race on the invoice row, not a lost payment —
      // reload and let the caller see the row another request already paid.
      return NextResponse.json(
        { error: "Invoice status changed while paying — reload and check its status." },
        { status: 409 },
      );
    }

    track("vendor_invoice_paid_from_balance", vendorUserId, { invoice_id: id, total_cents: totalCents });
    return NextResponse.json({ invoice: mapVendorInvoiceRow(data) });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to pay invoice from the PropLane balance.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
