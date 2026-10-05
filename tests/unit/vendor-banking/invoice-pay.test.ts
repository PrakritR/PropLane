import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeDb } from "./_fake-db";

const flagState = vi.hoisted(() => ({ enabled: false }));
vi.mock("@/lib/vendor-banking/flag", () => ({ vendorBankingEnabled: () => flagState.enabled }));

const stripeSession = vi.hoisted(() => ({ retrieve: vi.fn() }));
vi.mock("@/lib/stripe", () => ({ getStripe: () => ({
  checkout: { sessions: { retrieve: stripeSession.retrieve } }, paymentIntents: { retrieve: vi.fn() },
}) }));
vi.mock("@/lib/stripe-connect", () => ({
  resolveConnectDestinationIfReady: vi.fn().mockResolvedValue("acct_vendor_ready"),
}));
vi.mock("@/lib/app-url", () => ({ resolveShareableAppOrigin: () => "https://app.test" }));
vi.mock("@/lib/stripe-platform-hold.server", () => ({
  creditHoldFromPaidSession: vi.fn().mockResolvedValue({ credited: false }),
}));
vi.mock("@/lib/vendor-captured-source.server", () => ({
  creditVerifiedVendorCheckoutSource: vi.fn(),
  verifyLegacyVendorCheckoutSource: vi.fn().mockResolvedValue({ chargeId: "ch_legacy_invoice" }),
}));
vi.mock("@/lib/manager-bills.server", () => ({ createBillFromVendorInvoice: vi.fn() }));
const assertNoCrossRailPayout = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined));
vi.mock("@/lib/vendor-invoice-settlement.server", () => ({
  authorizeOutgoingInvoice: vi.fn(),
  assertNoCrossRailPayout: (...args: unknown[]) => assertNoCrossRailPayout(...args),
  settleInvoicePayment: vi.fn(async (db: { _tables: Record<string, Array<Record<string, unknown>>> },
    _manager: string, invoiceId: string) => {
    const row = db._tables.vendor_invoices?.find((invoice) => invoice.id === invoiceId);
    if (row) { row.status = "paid"; row.paid_from = "stripe"; }
  }),
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

import { startVendorInvoicePayCheckout, completeVendorInvoicePaymentFromStripeSession, releaseVendorInvoiceDirectPayClaim } from "@/lib/vendor-invoice-pay.server";

function invoiceRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "inv_1",
    manager_user_id: "manager_1",
    vendor_user_id: "vendor_1",
    total_cents: 10_000,
    status: "approved",
    invoice_number: "INV-1",
    memo: null,
    bill_id: "bill_1",
    payment_claim: "stripe",
    checkout_session_id: "cs_invoice_1",
    ...overrides,
  };
}

describe("startVendorInvoicePayCheckout", () => {
  beforeEach(() => {
    createAxisAchCheckoutSession.mockClear();
    flagState.enabled = false;
  });

  function startDb(rows: Array<Record<string, unknown>>) {
    const db = makeFakeDb({ vendor_invoices: rows }, {
      claim_vendor_invoice_stripe_checkout: async ({ p_attempt }) => {
        rows[0]!.checkout_session_id = p_attempt;
        return { data: p_attempt, error: null };
      },
      freeze_vendor_invoice_stripe_checkout_terms: async ({ p_terms }) => ({
        data: p_terms, error: null,
      }),
    });
    return db;
  }

  it("404s when the invoice doesn't belong to this manager (never trusts the id alone)", async () => {
    const db = startDb([invoiceRow({ checkout_session_id: null })]);
    const result = await startVendorInvoicePayCheckout(db as never, {
      invoiceId: "inv_1",
      managerUserId: "someone_else",
      managerEmail: "m@test.proplane.local",
    });
    expect(result).toEqual({ ok: false, status: 404, error: "Invoice not found." });
  });

  it("409s an invoice that isn't approved/scheduled yet", async () => {
    const db = startDb([invoiceRow({ status: "submitted", checkout_session_id: null })]);
    const result = await startVendorInvoicePayCheckout(db as never, {
      invoiceId: "inv_1",
      managerUserId: "manager_1",
      managerEmail: "m@test.proplane.local",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(409);
  });

  it("flag off: no PropLane fee applied, and the manager gets an embedded client secret", async () => {
    const db = startDb([invoiceRow({ checkout_session_id: null })]);
    const result = await startVendorInvoicePayCheckout(db as never, {
      invoiceId: "inv_1",
      managerUserId: "manager_1",
      managerEmail: "m@test.proplane.local",
      paymentMethod: "ach",
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
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

  it("a cross-rail refusal (another rail already paid the job) is a 409 before any claim or Stripe call", async () => {
    const { VendorInvoicePaymentRefusal } = await import("@/lib/vendor-invoices");
    assertNoCrossRailPayout.mockRejectedValueOnce(new VendorInvoicePaymentRefusal("This service has already been paid."));
    const db = startDb([invoiceRow({ checkout_session_id: null, payment_claim: null })]);
    const result = await startVendorInvoicePayCheckout(db as never, {
      invoiceId: "inv_1", managerUserId: "manager_1", managerEmail: "m@test.proplane.local", paymentMethod: "card",
    });
    expect(result).toMatchObject({ ok: false, status: 409, error: "This service has already been paid." });
    expect(createAxisAchCheckoutSession).not.toHaveBeenCalled();
  });

  it("a fault while reading the payout table is a 500, never reported as 'already paid'", async () => {
    assertNoCrossRailPayout.mockRejectedValueOnce(new Error("connection reset"));
    const db = startDb([invoiceRow({ checkout_session_id: null, payment_claim: null })]);
    const result = await startVendorInvoicePayCheckout(db as never, {
      invoiceId: "inv_1", managerUserId: "manager_1", managerEmail: "m@test.proplane.local", paymentMethod: "card",
    });
    expect(result).toMatchObject({ ok: false, status: 500 });
    expect(createAxisAchCheckoutSession).not.toHaveBeenCalled();
  });

  it("a claim the database refuses (cross-rail trigger or another rail holds it) is a 409 and no checkout is created", async () => {
    const rows = [invoiceRow({ checkout_session_id: null, payment_claim: null })];
    const db = makeFakeDb({ vendor_invoices: rows }, {
      claim_vendor_invoice_stripe_checkout: async () => ({ data: null, error: { code: "VP409", message: "This service already has a payout in progress or paid through another payment method." } }),
    });
    const result = await startVendorInvoicePayCheckout(db as never, {
      invoiceId: "inv_1", managerUserId: "manager_1", managerEmail: "m@test.proplane.local", paymentMethod: "card",
    });
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(createAxisAchCheckoutSession).not.toHaveBeenCalled();
  });

  it("flag on: 3% PropLane fee applied", async () => {
    flagState.enabled = true;
    const db = startDb([invoiceRow({ checkout_session_id: null })]);
    const result = await startVendorInvoicePayCheckout(db as never, {
      invoiceId: "inv_1",
      managerUserId: "manager_1",
      managerEmail: "m@test.proplane.local",
      paymentMethod: "ach",
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
  });

  function makeSession(overrides: Partial<Record<string, string>> = {}) {
    return {
      id: "cs_invoice_1",
      status: "complete",
      payment_status: "paid",
      currency: "usd",
      amount_total: 10100,
      metadata: {
        purpose: "vendor_invoice_direct_pay",
        invoice_id: "inv_1",
        manager_user_id: "manager_1",
        vendor_user_id: "vendor_1",
        invoice_cents: "10000",
        platform_fee_cents: "0",
        processing_fee_cents: "100",
        payment_method: "ach",
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
    await completeVendorInvoicePaymentFromStripeSession(db as never, makeSession({ platform_fee_cents: "300" }));
    const chargeLine = db._inserts.find((i) => i.table === "vendor_banking_ledger_entries" && i.row.kind === "charge");
    const feeLine = db._inserts.find((i) => i.table === "vendor_banking_ledger_entries" && i.row.kind === "platform_fee");
    expect(chargeLine?.row.amount_cents).toBe(10_000);
    expect(feeLine?.row.amount_cents).toBe(-300);
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

describe("releasing a Stripe invoice claim (one rule for expiry and bounced debits)", () => {
  const session = { id: "cs_invoice_1", metadata: { purpose: "vendor_invoice_direct_pay", invoice_id: "inv_1", manager_user_id: "manager_1" } };
  it("releases by session id only once Stripe says the session is expired", async () => {
    stripeSession.retrieve.mockResolvedValueOnce({ id: "cs_invoice_1", status: "expired" });
    const release = vi.fn(async () => ({ data: true, error: null }));
    const db = makeFakeDb({}, { release_vendor_invoice_stripe_checkout: release });
    await releaseVendorInvoiceDirectPayClaim(db as never, session as never);
    expect(release).toHaveBeenCalledWith({ p_invoice: "inv_1", p_manager: "manager_1", p_session: "cs_invoice_1" });
  });

  it("KEEPS the claim while the session is open or the ACH debit is still clearing", async () => {
    for (const live of [{ status: "open" }, { status: "complete", payment_status: "paid" }]) {
      stripeSession.retrieve.mockResolvedValueOnce({ id: "cs_invoice_1", ...live });
      const release = vi.fn(async () => ({ data: true, error: null }));
      const db = makeFakeDb({}, { release_vendor_invoice_stripe_checkout: release });
      await releaseVendorInvoiceDirectPayClaim(db as never, session as never);
      expect(release).not.toHaveBeenCalled();
    }
  });

  it("ignores a session for another purpose", async () => {
    stripeSession.retrieve.mockClear();
    const release = vi.fn(async () => ({ data: true, error: null }));
    const db = makeFakeDb({}, { release_vendor_invoice_stripe_checkout: release });
    await releaseVendorInvoiceDirectPayClaim(db as never, { id: "cs_x", metadata: { purpose: "household_charge" } } as never);
    expect(stripeSession.retrieve).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });
});
