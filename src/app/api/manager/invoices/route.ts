import { NextResponse } from "next/server";
import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";
import { loadManagerBillingIdentity } from "@/lib/manager-stripe-customer.server";
import { getStripe } from "@/lib/stripe";

export const runtime = "nodejs";

export type ManagerInvoiceRow = {
  id: string;
  date: string;
  totalCents: number;
  /** "Paid" / "Open" / "Void" for a subscription invoice; "Paid · credit" /
   * "Awaiting payment" / "Reversed" for a manual credit purchase. */
  status: string;
  /** Server-minted hosted URL. `null` when Stripe has none to offer yet
   * (an unpaid or not-yet-fulfilled row still lists, just with no link). */
  url: string | null;
};

const CREDIT_STATUS_LABEL: Record<string, string> = {
  paid: "Paid · credit",
  pending: "Awaiting payment",
  reversed: "Reversed",
};

const INVOICE_STATUS_LABEL: Record<string, string> = {
  paid: "Paid",
  open: "Open",
  draft: "Draft",
  uncollectible: "Uncollectible",
  void: "Void",
};

/**
 * Every hosted URL here is minted by Stripe server-side (`hosted_invoice_url`,
 * or a payment intent's `latest_charge.receipt_url`) — never constructed from
 * client input, and never guessed when Stripe hasn't produced one yet.
 */
export async function GET() {
  const auth = await requireManagerRouteUser();
  if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 403 });

  try {
    const rows: ManagerInvoiceRow[] = [];

    const identity = await loadManagerBillingIdentity(auth.db, auth.userId);
    if (identity.customerId) {
      const stripe = getStripe();
      const invoices = await stripe.invoices.list({ customer: identity.customerId, limit: 24 });
      for (const invoice of invoices.data) {
        rows.push({
          id: invoice.id ?? `invoice_${invoice.created}`,
          date: new Date(invoice.created * 1000).toISOString(),
          totalCents: invoice.total,
          status: INVOICE_STATUS_LABEL[invoice.status ?? ""] ?? (invoice.status ?? "Unknown"),
          url: invoice.hosted_invoice_url ?? invoice.invoice_pdf ?? null,
        });
      }
    }

    const { data: purchases, error: purchaseError } = await auth.db
      .from("manager_comms_credit_purchases")
      .select("id, credit_cents, status, created_at, receipt_url, stripe_payment_intent_id")
      .eq("manager_user_id", auth.userId)
      .order("created_at", { ascending: false })
      .limit(24);
    if (purchaseError) throw new Error("Could not load your purchase history.");

    for (const purchase of purchases ?? []) {
      if (purchase.status === "pending") continue;
      let url: string | null = purchase.receipt_url ?? null;
      if (!url && purchase.stripe_payment_intent_id) {
        // Best-effort: a receipt only exists once Stripe has settled the
        // charge. A failure here never blocks the row from listing.
        try {
          const stripe = getStripe();
          const intent = await stripe.paymentIntents.retrieve(purchase.stripe_payment_intent_id, {
            expand: ["latest_charge"],
          });
          const charge = intent.latest_charge;
          url = typeof charge === "object" && charge ? (charge.receipt_url ?? null) : null;
        } catch {
          url = null;
        }
      }
      rows.push({
        id: purchase.id,
        date: purchase.created_at,
        totalCents: purchase.credit_cents,
        status: CREDIT_STATUS_LABEL[purchase.status] ?? purchase.status,
        url,
      });
    }

    rows.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));

    return NextResponse.json({ invoices: rows }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    const message = e instanceof Error ? e.message : "We couldn't load your invoices. Try again.";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
