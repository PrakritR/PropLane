import { NextResponse } from "next/server";
import { getReportsAuthContext, assertManagerFinancialsAccess } from "@/lib/reports/auth";
import { authorizeOutgoingInvoice, claimInvoicePayment, settleInvoicePayment } from "@/lib/vendor-invoice-settlement.server";
import { postGlBillVoided } from "@/lib/reports/gl-posting";
import { isVendorInvoicePaymentRefusal, isVendorInvoiceRefusalSqlState, VendorInvoicePaymentRefusal } from "@/lib/vendor-invoices";
import { releaseInvoicePaymentClaim } from "@/lib/vendor-invoice-claim.server";
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const auth = await getReportsAuthContext({ preferRole: "manager" });
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const gate = await assertManagerFinancialsAccess(auth);
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });
    const body = await req.json() as { action?: string; date?: string; method?: string };
    const invoice = await authorizeOutgoingInvoice(auth.db, auth.userId, id);
    if (body.action === "offline") {
      const date = new Date(body.date ?? "");
      if (!Number.isFinite(date.getTime()) || date.getTime() > Date.now() || !["Cash", "Check", "Bank transfer", "Other"].includes(body.method ?? "")) return NextResponse.json({ error: "Choose a valid payment date and method." }, { status: 400 });
      await claimInvoicePayment(auth.db, auth.userId, id, "offline");
      try {
        await settleInvoicePayment(auth.db, auth.userId, id, "offline", date.toISOString(), body.method);
      } catch (settleError) {
        // Settle really does refuse ('Bill mismatch', 'Payment claim mismatch') and really can
        // fault. No money moved, so the claim has to go back: left behind, it made the invoice
        // unpayable by every rail and unschedulable and undeletable too. `.neq("status", "paid")`
        // inside the release makes it a no-op if the settle RPC had in fact committed.
        await releaseInvoicePaymentClaim(auth.db, auth.userId, id, "offline").catch((releaseError) =>
          console.error("[vendor-invoice-outgoing] could not release the offline claim after a failed settle", releaseError),
        );
        throw settleError;
      }
    } else if (body.action === "schedule" || body.action === "delete") {
      const { error } = await auth.db.rpc("manage_outgoing_invoice", { p_invoice: id, p_manager: auth.userId, p_action: body.action, p_date: body.date || null });
      if (error) throw isVendorInvoiceRefusalSqlState(error.code) ? new VendorInvoicePaymentRefusal(error.message) : new Error(error.message);
      if (body.action === "delete" && invoice.bill_id) {
        const { data: bill, error: billError } = await auth.db.from("manager_bills").select("*").eq("id", invoice.bill_id).eq("manager_user_id", auth.userId).single();
        if (billError) throw new Error(billError.message);
        await postGlBillVoided(auth.db, { managerUserId: auth.userId, billId: bill.id, amountCents: bill.amount_cents, entryDate: new Date().toISOString().slice(0,10), categoryCode: bill.category_code, propertyId: bill.property_id, vendorId: bill.vendor_id });
      }
    } else return NextResponse.json({ error: "Invalid action." }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not update invoice.";
    if (isVendorInvoicePaymentRefusal(e)) return NextResponse.json({ error: message }, { status: 409 });
    console.error("[vendor-invoice-outgoing] action failed", { invoiceId: id, error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const auth = await getReportsAuthContext({ preferRole: "manager" });
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const gate = await assertManagerFinancialsAccess(auth);
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });
    const invoice = await authorizeOutgoingInvoice(auth.db, auth.userId, (await ctx.params).id);
    const { data: profile } = await auth.db.from("profiles").select("stripe_connect_account_id, stripe_connect_payouts_enabled").eq("id", invoice.vendor_user_id).single();
    let destination = "Vendor’s PropLane balance";
    if (profile?.stripe_connect_account_id && profile.stripe_connect_payouts_enabled) {
      const { getStripe } = await import("@/lib/stripe");
      const account = await getStripe().accounts.retrieve(profile.stripe_connect_account_id);
      const bank = account.external_accounts?.data.find(item => item.object === "bank_account");
      if (bank?.object === "bank_account") destination = `${bank.bank_name || "Bank"} ••${bank.last4}`;
    }
    return NextResponse.json({ destination });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Could not read destination." }, { status: 400 }); }
}
