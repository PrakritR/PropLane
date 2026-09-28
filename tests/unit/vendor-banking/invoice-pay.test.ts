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
  vi.fn(async (_stripe: unknown, input: { amountCents?: number; extraApplicationFeeCents?: number }) => {
    const subtotalCents = input.amountCents ?? 0;
    return {
      mode: "hosted" as const,
      url: "https://checkout.stripe.test/x",
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
    ...overrides,
  };
}

describe("startVendorInvoicePayCheckout", () => {
  beforeEach(() => {
    createAxisAchCheckoutSession.mockClear();
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

  it("flag off: no PropLane fee applied", async () => {
    const db = makeFakeDb({ vendor_invoices: [invoiceRow()] });
    const result = await startVendorInvoicePayCheckout(db as never, {
      invoiceId: "inv_1",
      managerUserId: "manager_1",
      managerEmail: "m@test.proplane.local",
    });
    expect(result.ok).toBe(true);
    const call = createAxisAchCheckoutSession.mock.calls[0]![1] as Record<string, unknown>;
    expect(call.extraApplicationFeeCents).toBe(0);
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

  it("is idempotent — a redelivered webhook for an already-paid invoice writes no second payout row", async () => {
    const db = makeFakeDb({
      vendor_invoices: [invoiceRow({ status: "paid" })],
      vendor_payouts: [{ id: "payout_existing", invoice_id: "inv_1", vendor_user_id: "vendor_1", manager_user_id: "manager_1", amount_cents: 10_000, status: "paid" }],
    });
    await completeVendorInvoicePaymentFromStripeSession(db as never, makeSession());
    expect(db._tables.vendor_payouts!.length).toBe(1);
  });
});
