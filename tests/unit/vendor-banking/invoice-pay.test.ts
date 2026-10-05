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
vi.mock("@/lib/vendor-captured-source.server", () => ({
  creditVerifiedVendorCheckoutSource: vi.fn(),
  verifyLegacyVendorCheckoutSource: vi.fn().mockResolvedValue({ chargeId: "ch_legacy_invoice" }),
}));
vi.mock("@/lib/manager-bills.server", () => ({ createBillFromVendorInvoice: vi.fn() }));
vi.mock("@/lib/vendor-invoice-settlement.server", () => ({
  authorizeOutgoingInvoice: vi.fn(),
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

import { startVendorInvoicePayCheckout, completeVendorInvoicePaymentFromStripeSession } from "@/lib/vendor-invoice-pay.server";

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
