import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every invoice rail asks the same question the Approve + pay rail asks - "did ANOTHER payout already
 * move money for this job?" - before it claims or charges. The database is the arbiter (see
 * vendor-payout-cross-rail-guard-sql.test.ts); this is the friendly pre-check each rail runs first.
 */
vi.mock("server-only", () => ({}));
vi.mock("@/lib/reports/gl-posting", () => ({ postGlBillPaid: vi.fn() }));
vi.mock("@/lib/manager-bills.server", () => ({ createBillFromVendorInvoice: vi.fn(async () => undefined) }));
vi.mock("@/lib/workspaces/row-scope.server", () => ({
  resolveActiveWorkspaceRowScope: async () => ({}),
  rowAllowedInWorkspaceScope: () => true,
}));
vi.mock("@/lib/work-order-events.server", () => ({ workOrderEvent: vi.fn() }));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/stripe", () => ({ getStripe: vi.fn(() => ({})) }));
vi.mock("@/lib/stripe-connect", () => ({ resolveConnectDestinationIfReady: vi.fn(async () => null) }));
const createCheckout = vi.fn(async () => ({ mode: "embedded", clientSecret: "cs_1", sessionId: "sess_1" }));
vi.mock("@/lib/stripe-axis-ach-checkout", () => ({
  createAxisAchCheckoutSession: (...a: unknown[]) => createCheckout(...(a as [])),
  VENDOR_INVOICE_PAY_PURPOSE: "vendor_invoice_pay",
}));

import { assertNoCrossRailPayout, claimInvoicePayment } from "@/lib/vendor-invoice-settlement.server";
import { startVendorInvoicePayCheckout } from "@/lib/vendor-invoice-pay.server";

type Row = Record<string, unknown>;
const MANAGER = "mgr-1";
const WO = "wo-1";

let tables: Record<string, Row[]>;
// Mirrors `claim_vendor_invoice_payment`: the first claim stamps the rail on the invoice and
// inserts the pending payout row that IS the claim; a same-rail re-claim changes nothing.
const rpc = vi.fn(async (name: string, params: Record<string, unknown>) => {
  if (name === "claim_vendor_invoice_payment") {
    const invoice = (tables.vendor_invoices ?? []).find((r) => r.id === params.p_invoice);
    if (invoice && invoice.payment_claim == null) {
      invoice.payment_claim = params.p_rail;
      (tables.vendor_payouts ??= []).push({
        id: "po-claim",
        work_order_id: invoice.work_order_id,
        invoice_id: invoice.id,
        manager_user_id: params.p_manager,
        vendor_user_id: invoice.vendor_user_id,
        amount_cents: invoice.total_cents,
        status: "pending",
      });
    }
  }
  return { error: null };
});

function fakeDb() {
  return {
    rpc,
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const negated: Array<[string, unknown]> = [];
      let patch: Row | null = null;
      const rows = () =>
        (tables[table] ?? []).filter(
          (r) =>
            filters.every(([c, v]) => (Array.isArray(v) ? v.includes(r[c]) : r[c] === v)) &&
            negated.every(([c, v]) => r[c] !== v),
        );
      const apply = () => {
        const matched = rows();
        if (patch) for (const r of matched) Object.assign(r, patch);
        return matched;
      };
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (c: string, v: unknown) => (filters.push([c, v]), q),
        neq: (c: string, v: unknown) => (negated.push([c, v]), q),
        in: (c: string, v: unknown[]) => (filters.push([c, v]), q),
        update: (p: Row) => ((patch = p), q),
        maybeSingle: async () => ({ data: apply()[0] ?? null, error: null }),
        then: (resolve: (v: { data: Row[]; error: null }) => unknown) => Promise.resolve({ data: apply(), error: null }).then(resolve),
      };
      return q;
    },
  } as never;
}

function seed(over: { invoice?: Row; payouts?: Row[]; invoices?: Row[] } = {}) {
  tables = {
    vendor_invoices: [
      { id: "inv-job", manager_user_id: MANAGER, vendor_user_id: "v-1", work_order_id: WO, status: "approved", total_cents: 25_000, estimate_visit_bid_id: null, voided_at: null, ...over.invoice },
      ...(over.invoices ?? []),
    ],
    portal_work_order_records: [{ id: WO, manager_user_id: MANAGER, vendor_user_id: "v-1", property_id: "p-1" }],
    vendor_payouts: over.payouts ?? [],
  };
}

const approvePayPayout = (status = "paid"): Row => ({ id: "po-1", work_order_id: WO, invoice_id: null, status, amount_cents: 25_000, created_at: "2026-10-01T00:00:00Z" });

beforeEach(() => {
  vi.clearAllMocks();
  seed();
});

describe("invoice rails refuse a job that Approve + pay already paid", () => {
  it.each(["offline", "balance", "stripe"] as const)("%s: Approve + pay payout exists -> refused, the claim RPC is never called", async (rail) => {
    seed({ payouts: [approvePayPayout("pending")] });
    await expect(claimInvoicePayment(fakeDb(), MANAGER, "inv-job", rail)).rejects.toThrow(/already (paid|in progress)/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("with nothing paid yet the claim goes through to the database", async () => {
    await claimInvoicePayment(fakeDb(), MANAGER, "inv-job", "offline");
    expect(rpc).toHaveBeenCalledWith("claim_vendor_invoice_payment", { p_invoice: "inv-job", p_manager: MANAGER, p_rail: "offline" });
  });

  it("a payout that moved no money (failed / skipped) does not block", async () => {
    seed({ payouts: [approvePayPayout("failed")] });
    await claimInvoicePayment(fakeDb(), MANAGER, "inv-job", "balance");
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("the invoice's own claim row never blocks its own retry", async () => {
    seed({ payouts: [{ id: "po-own", work_order_id: WO, invoice_id: "inv-job", status: "pending", amount_cents: 25_000 }] });
    await claimInvoicePayment(fakeDb(), MANAGER, "inv-job", "balance");
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("another job invoice's payout blocks too (one job, one payment)", async () => {
    seed({
      payouts: [{ id: "po-2", work_order_id: WO, invoice_id: "inv-other", status: "paid", amount_cents: 25_000 }],
      invoices: [{ id: "inv-other", estimate_visit_bid_id: null }],
    });
    await expect(claimInvoicePayment(fakeDb(), MANAGER, "inv-job", "offline")).rejects.toThrow(/already paid/);
  });
});

describe("the estimate-visit fee is a separate bill", () => {
  it("paying the fee invoice is allowed even though the job was paid through Approve + pay", async () => {
    seed({
      invoice: { id: "inv-fee", estimate_visit_bid_id: "bid-1", total_cents: 5_000 },
      payouts: [approvePayPayout("paid")],
    });
    tables.work_order_bids = [{ id: "bid-1", work_order_id: WO, vendor_user_id: "v-1", manager_user_id: MANAGER, estimate_visit_done_at: "2026-10-02T00:00:00Z", estimate_visit_fee_cents: 5_000 }];
    await claimInvoicePayment(fakeDb(), MANAGER, "inv-fee", "offline");
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("a paid fee payout does not block the job invoice", async () => {
    seed({
      payouts: [{ id: "po-fee", work_order_id: WO, invoice_id: "inv-fee", status: "paid", amount_cents: 5_000 }],
      invoices: [{ id: "inv-fee", estimate_visit_bid_id: "bid-1" }],
    });
    await expect(assertNoCrossRailPayout(fakeDb(), { id: "inv-job", work_order_id: WO, estimate_visit_bid_id: null })).resolves.toBeUndefined();
  });
});

describe("Stripe invoice pay", () => {
  it("is refused (409) before any checkout session when the job was already paid", async () => {
    seed({ payouts: [approvePayPayout("paid")] });
    const result = await startVendorInvoicePayCheckout(fakeDb(), { invoiceId: "inv-job", managerUserId: MANAGER, managerEmail: "m@x.test" });
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(createCheckout).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("CLAIMS the payout through the same RPC the other rails use, before the card is charged", async () => {
    const result = await startVendorInvoicePayCheckout(fakeDb(), { invoiceId: "inv-job", managerUserId: MANAGER, managerEmail: "m@x.test" });
    expect(result).toMatchObject({ ok: true, clientSecret: "cs_1" });
    expect(rpc).toHaveBeenCalledWith("claim_vendor_invoice_payment", { p_invoice: "inv-job", p_manager: MANAGER, p_rail: "stripe" });
    expect(rpc.mock.invocationCallOrder[0]!).toBeLessThan(createCheckout.mock.invocationCallOrder[0]!);
    // The claim now exists as a pending payout, which is what refuses Approve + pay, and it is
    // tied to the session holding it so only that session's expiry can give it back.
    expect(tables.vendor_payouts).toMatchObject([{ invoice_id: "inv-job", status: "pending" }]);
    expect(tables.vendor_invoices![0]).toMatchObject({ payment_claim: "stripe", checkout_session_id: "sess_1" });
  });

  it("a read fault on the payout table is 500, not a double-pay refusal", async () => {
    const db = fakeDb() as unknown as { from: (table: string) => unknown };
    const inner = db.from;
    const faulting = {
      from(table: string) {
        if (table !== "vendor_payouts") return inner(table);
        const q: Record<string, unknown> = {
          select: () => q,
          eq: () => q,
          then: (resolve: (v: { data: null; error: { message: string } }) => unknown) =>
            Promise.resolve({ data: null, error: { message: "connection reset" } }).then(resolve),
        };
        return q;
      },
    };
    const result = await startVendorInvoicePayCheckout(faulting as never, { invoiceId: "inv-job", managerUserId: MANAGER, managerEmail: "m@x.test" });
    expect(result).toMatchObject({ ok: false, status: 500 });
    if (!result.ok) expect(result.error).toContain("connection reset");
    expect(createCheckout).not.toHaveBeenCalled();
  });
});
