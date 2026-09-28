import { NextResponse } from "next/server";
import { assertManagerFinancialsAccess, getReportsAuthContext } from "@/lib/reports/auth";
import { vendorBankingEnabled } from "@/lib/vendor-banking/flag";
import { startVendorInvoicePayCheckout } from "@/lib/vendor-invoice-pay.server";

export const runtime = "nodejs";

/**
 * Manager pays an approved/scheduled vendor invoice in-app — "Request
 * payment" (VD48/49). New: no manager-facing pay screen for `vendor_invoices`
 * existed before this build. Gated behind VENDOR_BANKING_ENABLED like every
 * other new vendor-banking money path; with the flag off this route 404s and
 * the manager still uses the existing decision route's bookkeeping-only
 * "mark paid", unchanged.
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

    const result = await startVendorInvoicePayCheckout(auth.db, {
      invoiceId: id,
      managerUserId: auth.userId,
      managerEmail: auth.email || "manager@proplane.app",
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ url: result.url, sessionId: result.sessionId });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not start payment.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
