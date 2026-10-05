import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeDb } from "./_fake-db";

const flagState = vi.hoisted(() => ({ enabled: false }));
vi.mock("@/lib/vendor-banking/flag", () => ({ vendorBankingEnabled: () => flagState.enabled }));

vi.mock("@/lib/stripe", () => ({ getStripe: () => ({}) }));
vi.mock("@/lib/stripe-connect", () => ({
  resolveConnectDestinationIfReady: vi.fn().mockResolvedValue("acct_vendor_ready"),
}));
vi.mock("@/lib/app-url", () => ({ resolveShareableAppOrigin: () => "https://app.test" }));
vi.mock("@/lib/stripe-platform-hold.server", () => ({
  creditHoldFromPaidSession: vi.fn().mockResolvedValue({ credited: false }),
}));

const createAxisAchCheckoutSession = vi.hoisted(() =>
  vi.fn(async (_stripe: unknown, input: { amountCents?: number; extraApplicationFeeCents?: number; mode?: string; returnUrl?: string }) => {
    const subtotalCents = input.amountCents ?? 0;
    return {
      mode: "embedded" as const,
      clientSecret: "cs_test_secret_x",
      sessionId: "cs_invoice_1",
      subtotalCents,
      processingFeeCents: 100,
      axisFeeCents: 0,
      platformFeeCents: input.extraApplicationFeeCents ?? 0,
      totalCents: subtotalCents + 100,
      paymentMethod: "ach" as const,
    };
  }),
);
vi.mock("@/lib/stripe-axis-ach-checkout", async (orig) => {
  const actual = await orig<typeof import("@/lib/stripe-axis-ach-checkout")>();
  return { ...actual, createAxisAchCheckoutSession };
});

// The cross-rail claim itself is exercised against the real RPC in
// vendor-invoice-cross-rail-double-pay.test.ts; here we assert this rail's ORCHESTRATION of it.
const claimInvoicePayment = vi.hoisted(() => vi.fn(async () => undefined));
const assertNoCrossRailPayout = vi.hoisted(() => vi.fn(async () => undefined));
const settleInvoicePayment = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/vendor-invoice-settlement.server", () => ({
  claimInvoicePayment,
  assertNoCrossRailPayout,
  settleInvoicePayment,
}));
const releaseInvoicePaymentClaim = vi.hoisted(() => vi.fn(async () => true));
const readInvoicePaymentClaimId = vi.hoisted(() => vi.fn(async (): Promise<string | null> => "claim_1"));
vi.mock("@/lib/vendor-invoice-claim.server", () => ({ releaseInvoicePaymentClaim, readInvoicePaymentClaimId }));

import {
  startVendorInvoicePayCheckout,
  completeVendorInvoicePaymentFromStripeSession,
  releaseVendorInvoiceDirectPayClaim,
} from "@/lib/vendor-invoice-pay.server";
import { VendorInvoicePaymentRefusal } from "@/lib/vendor-invoices";

function invoiceRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "inv_1",
    manager_user_id: "manager_1",
    vendor_user_id: "vendor_1",
    total_cents: 10_000,
    status: "approved",
    invoice_number: "INV-1",
    memo: null,
    ...overrides,
  };
}

describe("startVendorInvoicePayCheckout", () => {
  beforeEach(() => {
    createAxisAchCheckoutSession.mockClear();
    createAxisAchCheckoutSession.mockImplementation(async (_stripe: unknown, input: { amountCents?: number; extraApplicationFeeCents?: number; mode?: string; returnUrl?: string }) => {
      const subtotalCents = input.amountCents ?? 0;
      return {
        mode: "embedded" as const,
        clientSecret: "cs_test_secret_x",
        sessionId: "cs_invoice_1",
        status: "open" as const,
        expiresAtUnix: Math.floor(Date.now() / 1000) + 30 * 60,
        subtotalCents,
        processingFeeCents: 100,
        axisFeeCents: 0,
        platformFeeCents: input.extraApplicationFeeCents ?? 0,
        totalCents: subtotalCents + 100,
        paymentMethod: "ach" as const,
      };
    });
    claimInvoicePayment.mockClear();
    claimInvoicePayment.mockImplementation(async () => undefined);
    assertNoCrossRailPayout.mockClear();
    releaseInvoicePaymentClaim.mockClear();
    releaseInvoicePaymentClaim.mockImplementation(async () => true);
    readInvoicePaymentClaimId.mockClear();
    readInvoicePaymentClaimId.mockImplementation(async () => "claim_1");
    flagState.enabled = false;
  });

  it("404s when the invoice doesn't belong to this manager (never trusts the id alone)", async () => {
    const db = makeFakeDb({ vendor_invoices: [invoiceRow()] });
    const result = await startVendorInvoicePayCheckout(db as never, {
      invoiceId: "inv_1",
      managerUserId: "someone_else",
      managerEmail: "m@test.proplane.local",
    });
    expect(result).toEqual({ ok: false, status: 404, error: "Invoice not found." });
  });

  it("409s an invoice that isn't approved/scheduled yet", async () => {
    const db = makeFakeDb({ vendor_invoices: [invoiceRow({ status: "submitted" })] });
    const result = await startVendorInvoicePayCheckout(db as never, {
      invoiceId: "inv_1",
      managerUserId: "manager_1",
      managerEmail: "m@test.proplane.local",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(409);
  });

  it("flag off: no PropLane fee applied, and the manager gets an embedded client secret", async () => {
    const db = makeFakeDb({ vendor_invoices: [invoiceRow()] });
    const result = await startVendorInvoicePayCheckout(db as never, {
      invoiceId: "inv_1",
      managerUserId: "manager_1",
      managerEmail: "m@test.proplane.local",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.clientSecret).toBe("cs_test_secret_x");
    expect(result.platformFeeCents).toBe(0);
    expect(result.invoiceCents).toBe(10_000);
    const call = createAxisAchCheckoutSession.mock.calls[0]![1] as Record<string, unknown>;
    expect(call.extraApplicationFeeCents).toBe(0);
    // Never a hosted redirect — the manager stays inside PropLane.
    expect(call.mode).toBe("embedded");
    expect(typeof call.returnUrl).toBe("string");
    expect(call.returnUrl).toContain("/portal/finances");
  });

  it("a job invoice CLAIMS the payout before the card is charged, and the session cannot outlive the hold", async () => {
    const db = makeFakeDb({ vendor_invoices: [invoiceRow({ work_order_id: "wo_1", payment_claim: "stripe" })] });
    const result = await startVendorInvoicePayCheckout(db as never, {
      invoiceId: "inv_1",
      managerUserId: "manager_1",
      managerEmail: "m@test.proplane.local",
    });
    expect(result.ok).toBe(true);
    expect(claimInvoicePayment).toHaveBeenCalledWith(db, "manager_1", "inv_1", "stripe");
    // The claim is held BEFORE Stripe is asked for a session, so Approve + pay is already refused.
    expect(claimInvoicePayment.mock.invocationCallOrder[0]!).toBeLessThan(
      createAxisAchCheckoutSession.mock.invocationCallOrder[0]!,
    );
    const call = createAxisAchCheckoutSession.mock.calls[0]![1] as { expiresAtUnix?: number; idempotencyKey?: string };
    const ttl = call.expiresAtUnix! - Math.floor(Date.now() / 1000);
    expect(ttl).toBeGreaterThanOrEqual(30 * 60);
    expect(ttl).toBeLessThanOrEqual(31 * 60);
    // The key is scoped to the CLAIM, so it can never outlive the session it created: an
    // invoice-wide key replayed the expired session for 24 hours and stranded the next claim.
    expect(call.idempotencyKey).toBe("vendor-invoice:inv_1:claim_1");
    // The claim is tied to the session that holds it, so only that session's expiry frees it.
    expect(db._tables.vendor_invoices![0]!.checkout_session_id).toBe("cs_invoice_1");
  });

  it("a fresh claim after an expiry gets a fresh idempotency key, so Stripe cannot replay the dead session", async () => {
    const first = makeFakeDb({ vendor_invoices: [invoiceRow({ work_order_id: "wo_1", payment_claim: "stripe" })] });
    await startVendorInvoicePayCheckout(first as never, { invoiceId: "inv_1", managerUserId: "manager_1", managerEmail: "m@test.proplane.local" });
    readInvoicePaymentClaimId.mockImplementation(async () => "claim_2");
    const second = makeFakeDb({ vendor_invoices: [invoiceRow({ work_order_id: "wo_1", payment_claim: "stripe" })] });
    await startVendorInvoicePayCheckout(second as never, { invoiceId: "inv_1", managerUserId: "manager_1", managerEmail: "m@test.proplane.local" });
    const keys = createAxisAchCheckoutSession.mock.calls.map((c) => (c[1] as { idempotencyKey?: string }).idempotencyKey);
    expect(keys).toEqual(["vendor-invoice:inv_1:claim_1", "vendor-invoice:inv_1:claim_2"]);
  });

  it("refuses a session Stripe hands back already expired, and releases the claim", async () => {
    const db = makeFakeDb({ vendor_invoices: [invoiceRow({ work_order_id: "wo_1", payment_claim: "stripe" })] });
    createAxisAchCheckoutSession.mockImplementation(async () => ({
      mode: "embedded" as const,
      clientSecret: "cs_test_secret_stale",
      sessionId: "cs_invoice_stale",
      status: "expired" as const,
      expiresAtUnix: Math.floor(Date.now() / 1000) - 60,
      subtotalCents: 10_000,
      processingFeeCents: 100,
      axisFeeCents: 0,
      platformFeeCents: 0,
      totalCents: 10_100,
      paymentMethod: "ach" as const,
    }));
    const result = await startVendorInvoicePayCheckout(db as never, { invoiceId: "inv_1", managerUserId: "manager_1", managerEmail: "m@test.proplane.local" });
    expect(result).toMatchObject({ ok: false, status: 500 });
    expect(releaseInvoicePaymentClaim).toHaveBeenCalledWith(db, "manager_1", "inv_1", "stripe");
  });

  it("refuses when the claim cannot be tied to its session, rather than leaving an untied claim", async () => {
    // No invoice row still claimed by "stripe" for the tie to match.
    const db = makeFakeDb({ vendor_invoices: [invoiceRow({ work_order_id: "wo_1", payment_claim: null })] });
    const result = await startVendorInvoicePayCheckout(db as never, { invoiceId: "inv_1", managerUserId: "manager_1", managerEmail: "m@test.proplane.local" });
    expect(result).toMatchObject({ ok: false, status: 500 });
    expect(releaseInvoicePaymentClaim).toHaveBeenCalledWith(db, "manager_1", "inv_1", "stripe");
  });

  it("refuses when the claim has no row to point at", async () => {
    readInvoicePaymentClaimId.mockImplementation(async () => null);
    const db = makeFakeDb({ vendor_invoices: [invoiceRow({ work_order_id: "wo_1", payment_claim: "stripe" })] });
    const result = await startVendorInvoicePayCheckout(db as never, { invoiceId: "inv_1", managerUserId: "manager_1", managerEmail: "m@test.proplane.local" });
    expect(result).toMatchObject({ ok: false, status: 500 });
    expect(createAxisAchCheckoutSession).not.toHaveBeenCalled();
  });

  it("a standalone invoice has no job to claim — it only runs the cross-rail check", async () => {
    const db = makeFakeDb({ vendor_invoices: [invoiceRow()] });
    const result = await startVendorInvoicePayCheckout(db as never, {
      invoiceId: "inv_1",
      managerUserId: "manager_1",
      managerEmail: "m@test.proplane.local",
    });
    expect(result.ok).toBe(true);
    expect(claimInvoicePayment).not.toHaveBeenCalled();
    expect(assertNoCrossRailPayout).toHaveBeenCalled();
    // Nothing is being held, so the session keeps Stripe's 24h default and stays in step with the
    // invoice-wide idempotency key — a short expiry here would brick the retry instead.
    const call = createAxisAchCheckoutSession.mock.calls[0]![1] as { expiresAtUnix?: number };
    expect(call.expiresAtUnix).toBeUndefined();
  });

  it("a refused claim is 409; a database FAULT is 500, never 'already paid'", async () => {
    const db = makeFakeDb({ vendor_invoices: [invoiceRow({ work_order_id: "wo_1" })] });
    claimInvoicePayment.mockImplementation(async () => {
      throw new VendorInvoicePaymentRefusal("This service is already paid through Approve + pay.");
    });
    const refused = await startVendorInvoicePayCheckout(db as never, { invoiceId: "inv_1", managerUserId: "manager_1", managerEmail: "m@test.proplane.local" });
    expect(refused).toMatchObject({ ok: false, status: 409 });

    claimInvoicePayment.mockImplementation(async () => {
      throw new Error("Could not check for an existing payout: connection reset");
    });
    const faulted = await startVendorInvoicePayCheckout(db as never, { invoiceId: "inv_1", managerUserId: "manager_1", managerEmail: "m@test.proplane.local" });
    expect(faulted).toMatchObject({ ok: false, status: 500 });
    if (!faulted.ok) expect(faulted.error).toContain("connection reset");
    expect(createAxisAchCheckoutSession).not.toHaveBeenCalled();
  });

  it("releases the claim when Stripe will not open the session, so the invoice stays payable", async () => {
    const db = makeFakeDb({ vendor_invoices: [invoiceRow({ work_order_id: "wo_1" })] });
    createAxisAchCheckoutSession.mockImplementation(async () => {
      throw new Error("Stripe is down");
    });
    const result = await startVendorInvoicePayCheckout(db as never, { invoiceId: "inv_1", managerUserId: "manager_1", managerEmail: "m@test.proplane.local" });
    expect(result).toMatchObject({ ok: false, status: 500 });
    expect(releaseInvoicePaymentClaim).toHaveBeenCalledWith(db, "manager_1", "inv_1", "stripe");
  });

  it("an expired or bounced session hands the claim back", async () => {
    const db = makeFakeDb({});
    await releaseVendorInvoiceDirectPayClaim(db as never, {
      id: "cs_1",
      metadata: { purpose: "vendor_invoice_direct_pay", invoice_id: "inv_1", manager_user_id: "manager_1" },
    } as unknown as import("stripe").default.Checkout.Session);
    // Scoped to the session that took the claim: a replayed event for another attempt is a no-op.
    expect(releaseInvoicePaymentClaim).toHaveBeenCalledWith(db, "manager_1", "inv_1", "stripe", { checkoutSessionId: "cs_1" });

    releaseInvoicePaymentClaim.mockClear();
    await releaseVendorInvoiceDirectPayClaim(db as never, {
      id: "cs_2",
      metadata: { purpose: "something_else", invoice_id: "inv_1", manager_user_id: "manager_1" },
    } as unknown as import("stripe").default.Checkout.Session);
    expect(releaseInvoicePaymentClaim).not.toHaveBeenCalled();
  });

  it("flag on: 3% PropLane fee applied", async () => {
    flagState.enabled = true;
    const db = makeFakeDb({ vendor_invoices: [invoiceRow()] });
    const result = await startVendorInvoicePayCheckout(db as never, {
      invoiceId: "inv_1",
      managerUserId: "manager_1",
      managerEmail: "m@test.proplane.local",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.platformFeeCents).toBe(300);
    const call = createAxisAchCheckoutSession.mock.calls[0]![1] as Record<string, unknown>;
    expect(call.extraApplicationFeeCents).toBe(300);
  });
});

describe("completeVendorInvoicePaymentFromStripeSession", () => {
  beforeEach(() => {
    flagState.enabled = false;
    settleInvoicePayment.mockClear();
  });

  function makeSession(overrides: Partial<Record<string, string>> = {}) {
    return {
      id: "cs_invoice_1",
      payment_status: "paid",
      metadata: {
        purpose: "vendor_invoice_direct_pay",
        invoice_id: "inv_1",
        manager_user_id: "manager_1",
        vendor_user_id: "vendor_1",
        invoice_cents: "10000",
        platform_fee_cents: "300",
        ...overrides,
      },
    } as unknown as import("stripe").default.Checkout.Session;
  }

  it("marks the invoice paid and writes a vendor_payouts row keyed by invoice_id", async () => {
    const db = makeFakeDb({ vendor_invoices: [invoiceRow()], vendor_payouts: [] });
    await completeVendorInvoicePaymentFromStripeSession(db as never, makeSession());
    const invoice = db._tables.vendor_invoices![0]!;
    expect(invoice.status).toBe("paid");
    expect(invoice.paid_from).toBe("stripe");
    const payout = db._tables.vendor_payouts![0]!;
    expect(payout).toMatchObject({ invoice_id: "inv_1", vendor_user_id: "vendor_1", amount_cents: 10_000, status: "paid" });
  });

  it("writes ledger charge + fee lines only when the flag is on", async () => {
    flagState.enabled = true;
    const db = makeFakeDb({ vendor_invoices: [invoiceRow()], vendor_payouts: [] });
    await completeVendorInvoicePaymentFromStripeSession(db as never, makeSession());
    const chargeLine = db._inserts.find((i) => i.table === "vendor_banking_ledger_entries" && i.row.kind === "charge");
    const feeLine = db._inserts.find((i) => i.table === "vendor_banking_ledger_entries" && i.row.kind === "platform_fee");
    expect(chargeLine?.row.amount_cents).toBe(10_000);
    expect(feeLine?.row.amount_cents).toBe(-300);
  });

  it("converts the held claim into the settled payout through the shared settle", async () => {
    const db = makeFakeDb({
      vendor_invoices: [invoiceRow({ work_order_id: "wo_1", payment_claim: "stripe" })],
      vendor_payouts: [{ id: "payout_claim", invoice_id: "inv_1", manager_user_id: "manager_1", vendor_user_id: "vendor_1", amount_cents: 10_000, status: "pending" }],
    });
    await completeVendorInvoicePaymentFromStripeSession(db as never, makeSession());
    expect(settleInvoicePayment).toHaveBeenCalledWith(db, "manager_1", "inv_1", "stripe");
    // The claim row IS the payout — stamped with the Stripe ids, never duplicated.
    expect(db._tables.vendor_payouts!.length).toBe(1);
    expect(db._tables.vendor_payouts![0]).toMatchObject({ id: "payout_claim", status: "paid", stripe_transfer_id: "cs_invoice_1" });
  });

  it("a retry after a failed payout write still records the payout — the claim says this session owns it", async () => {
    // The first delivery marked the invoice paid and then threw before the payout row landed.
    // Gating the redelivery on the invoice status alone lost the payout and the vendor's credit.
    flagState.enabled = true;
    const db = makeFakeDb({
      vendor_invoices: [invoiceRow({ status: "paid", work_order_id: "wo_1", payment_claim: "stripe" })],
      vendor_payouts: [],
    });
    await completeVendorInvoicePaymentFromStripeSession(db as never, makeSession());
    expect(db._tables.vendor_payouts![0]).toMatchObject({ invoice_id: "inv_1", amount_cents: 10_000, status: "paid" });
    expect(db._inserts.some((i) => i.table === "vendor_banking_ledger_entries" && i.row.kind === "charge")).toBe(true);
  });

  it("is idempotent — a redelivered webhook for an already-paid invoice writes no second payout row", async () => {
    const db = makeFakeDb({
      vendor_invoices: [invoiceRow({ status: "paid" })],
      vendor_payouts: [{ id: "payout_existing", invoice_id: "inv_1", vendor_user_id: "vendor_1", manager_user_id: "manager_1", amount_cents: 10_000, status: "paid" }],
    });
    await completeVendorInvoicePaymentFromStripeSession(db as never, makeSession());
    expect(db._tables.vendor_payouts!.length).toBe(1);
  });
});
