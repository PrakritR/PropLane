import { describe, expect, it, vi } from "vitest";
import { makeFakeDb, type Row } from "./_fake-db";

/**
 * Handing a payment claim back is a compare-and-swap on the invoice, not an unconditional wipe.
 * Stripe redelivers `checkout.session.expired` / `async_payment_failed` on any non-2xx and on
 * manual replay, so a stale event for an abandoned attempt must not free the claim a live payment
 * is holding — and must never reach across rails into the balance/offline rails' payout row.
 */
vi.mock("server-only", () => ({}));

const { releaseInvoicePaymentClaim } = await import("@/lib/vendor-invoice-claim.server");

const MANAGER = "manager_1";
const INVOICE = "inv_1";

function seed(invoice: Row, payouts: Row[] = [{ id: "payout_claim", invoice_id: INVOICE, manager_user_id: MANAGER, status: "pending" }]) {
  return makeFakeDb({
    vendor_invoices: [{ id: INVOICE, manager_user_id: MANAGER, status: "approved", ...invoice }],
    vendor_payouts: payouts,
  });
}

describe("releaseInvoicePaymentClaim", () => {
  it("releases the claim the named session is holding", async () => {
    const db = seed({ payment_claim: "stripe", checkout_session_id: "cs_live" });
    const released = await releaseInvoicePaymentClaim(db as never, MANAGER, INVOICE, "stripe", { checkoutSessionId: "cs_live" });
    expect(released).toBe(true);
    expect(db._tables.vendor_invoices![0]!.payment_claim).toBe(null);
    expect(db._tables.vendor_payouts).toEqual([]);
  });

  it("a replayed event for a DIFFERENT session is a no-op — the live payment keeps its claim", async () => {
    const db = seed({ payment_claim: "stripe", checkout_session_id: "cs_live" });
    const released = await releaseInvoicePaymentClaim(db as never, MANAGER, INVOICE, "stripe", { checkoutSessionId: "cs_abandoned" });
    expect(released).toBe(false);
    expect(db._tables.vendor_invoices![0]!.payment_claim).toBe("stripe");
    expect(db._tables.vendor_payouts!.length).toBe(1);
  });

  it("a stale stripe expiry never touches the balance rail's claim or its payout row", async () => {
    // The unscoped DELETE used to wipe this row while leaving payment_claim='balance', after which
    // settle_vendor_invoice_payment flipped zero rows and the payout record was lost outright.
    const db = seed({ payment_claim: "balance", checkout_session_id: null });
    const released = await releaseInvoicePaymentClaim(db as never, MANAGER, INVOICE, "stripe", { checkoutSessionId: "cs_stale" });
    expect(released).toBe(false);
    expect(db._tables.vendor_invoices![0]!.payment_claim).toBe("balance");
    expect(db._tables.vendor_payouts!.length).toBe(1);
  });

  it("never releases a settled payment", async () => {
    const db = seed({ status: "paid", payment_claim: "stripe", checkout_session_id: "cs_live" });
    const released = await releaseInvoicePaymentClaim(db as never, MANAGER, INVOICE, "stripe", { checkoutSessionId: "cs_live" });
    expect(released).toBe(false);
    expect(db._tables.vendor_invoices![0]!.payment_claim).toBe("stripe");
    expect(db._tables.vendor_payouts!.length).toBe(1);
  });

  it("sweeps an orphan pending payout once nothing holds the invoice, so a half-done release self-heals", async () => {
    const db = seed({ payment_claim: null, checkout_session_id: null });
    const released = await releaseInvoicePaymentClaim(db as never, MANAGER, INVOICE, "stripe");
    expect(released).toBe(false);
    expect(db._tables.vendor_payouts).toEqual([]);
  });

  it("the balance rail releases its own claim without naming a session", async () => {
    const db = seed({ payment_claim: "balance", checkout_session_id: null });
    const released = await releaseInvoicePaymentClaim(db as never, MANAGER, INVOICE, "balance");
    expect(released).toBe(true);
    expect(db._tables.vendor_invoices![0]!.payment_claim).toBe(null);
    expect(db._tables.vendor_payouts).toEqual([]);
  });
});
