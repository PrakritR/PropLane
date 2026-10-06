import { NextResponse } from "next/server";
import { assertManagerFinancialsAccess, getReportsAuthContext } from "@/lib/reports/auth";
import { vendorBankingEnabled } from "@/lib/vendor-banking/flag";
import { startVendorInvoicePayCheckout } from "@/lib/vendor-invoice-pay.server";

export const runtime = "nodejs";

/**
 * Manager pays an approved/scheduled vendor invoice in-app — "Request
 * payment" (VD48/49). Returns a Stripe EMBEDDED Checkout client secret (never
 * a hosted redirect URL) so the card/ACH form mounts inside a PropLane modal
 * — the manager never leaves the app. Gated behind VENDOR_BANKING_ENABLED
 * like every other new vendor-banking money path; with the flag off this
 * route 404s and the manager still uses the existing decision route's
 * bookkeeping-only "mark paid", unchanged.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    if (!vendorBankingEnabled()) {
      return NextResponse.json({ error: "In-app invoice payment is not enabled." }, { status: 404 });
    }
    const { id } = await ctx.params;
    const auth = await getReportsAuthContext();
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const gate = await assertManagerFinancialsAccess(auth);
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

    const body = (await req.json().catch(() => ({}))) as { paymentMethod?: unknown };
    if (body.paymentMethod !== "card" && body.paymentMethod !== "ach") {
      return NextResponse.json({ error: "Choose card or bank transfer." }, { status: 400 });
    }
    const result = await startVendorInvoicePayCheckout(auth.db, {
      invoiceId: id,
      managerUserId: auth.userId,
      managerEmail: auth.email || "manager@proplane.app",
      paymentMethod: body.paymentMethod,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({
      clientSecret: result.clientSecret,
      sessionId: result.sessionId,
      invoiceCents: result.invoiceCents,
      platformFeeCents: result.platformFeeCents,
      processingFeeCents: result.processingFeeCents,
      totalCents: result.totalCents,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not start payment.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
