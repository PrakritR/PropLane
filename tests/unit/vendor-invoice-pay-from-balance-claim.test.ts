/**
 * `claim_vendor_invoice_payment` makes one rail own the invoice so a manager
 * cannot pay the same bill twice. The claim therefore has to be RELEASED on
 * every path where no money moved - not just on insufficient balance. A claim
 * left behind had the RPC reject every other rail, so the invoice could no
 * longer be paid by bank, paid offline, scheduled or deleted at all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const moveResult: { value: unknown; throws: boolean } = { value: null, throws: false };
const payVendorFromBalance = vi.fn(async () => {
  if (moveResult.throws) throw new Error("ledger unavailable");
  return moveResult.value;
});
const claimInvoicePayment = vi.fn(async () => undefined);
const settleInvoicePayment = vi.fn(async () => undefined);

vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/proplane-balance/flag", () => ({ proplaneBalanceEnabled: () => true }));
vi.mock("@/lib/proplane-balance/ledger.server", () => ({
  payVendorFromBalance: (...a: unknown[]) => payVendorFromBalance(...(a as [])),
}));
vi.mock("@/lib/vendor-invoice-settlement.server", () => ({
  claimInvoicePayment: (...a: unknown[]) => claimInvoicePayment(...(a as [])),
  settleInvoicePayment: (...a: unknown[]) => settleInvoicePayment(...(a as [])),
}));
vi.mock("@/lib/reports/auth", () => ({
  getReportsAuthContext: async () => ({ db: fake.db, userId: MANAGER }),
  assertManagerFinancialsAccess: async () => ({ ok: true }),
}));

import { POST } from "@/app/api/vendor/invoices/[id]/pay-from-balance/route";

const MANAGER = "mgr-1";
const INVOICE = "inv-1";
type Row = Record<string, unknown>;

/** Records the two writes that release a claim, and nothing else. */
const fake = {
  db: null as unknown,
  payoutDeletes: [] as Row[][],
  invoiceUpdates: [] as Row[],
};

function fakeDb() {
  fake.payoutDeletes = [];
  fake.invoiceUpdates = [];
  const from = (table: string) => {
    const filters: Row[] = [];
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (column: string, value: unknown) => (filters.push({ column, value }), q),
      neq: (column: string, value: unknown) => (filters.push({ column, value, op: "neq" }), q),
      maybeSingle: async () => ({
        data: {
          id: INVOICE,
          status: "approved",
          vendor_user_id: "vendor-1",
          total_cents: 25_000,
          work_order_id: "wo-1",
          bill_id: null,
        },
        error: null,
      }),
      single: async () => ({ data: { id: INVOICE }, error: null }),
      delete: () => {
        if (table === "vendor_payouts") fake.payoutDeletes.push(filters);
        return q;
      },
      update: (patch: Row) => {
        if (table === "vendor_invoices") fake.invoiceUpdates.push(patch);
        return q;
      },
      then: (resolve: (v: { data: Row[]; error: null }) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(resolve),
    };
    return q;
  };
  fake.db = { from };
  return fake.db;
}

const call = () =>
  POST(new Request("https://x.test/api/vendor/invoices/inv-1/pay-from-balance", { method: "POST" }), {
    params: Promise.resolve({ id: INVOICE }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  moveResult.throws = false;
  fakeDb();
});

describe("pay from the PropLane balance", () => {
  it("releases the claim when the balance is short (422)", async () => {
    moveResult.value = { ok: false, code: "insufficient_balance", availableCents: 1_000, requestedCents: 25_000, shortfallCents: 24_000 };
    const res = await call();
    expect(res.status).toBe(422);
    expect(fake.payoutDeletes).toHaveLength(1);
    expect(fake.invoiceUpdates[0]).toMatchObject({ payment_claim: null });
  });

  it("releases the claim on any OTHER ledger failure too", async () => {
    moveResult.value = { ok: false, code: "ledger_error", error: "boom" };
    const res = await call();
    expect(res.status).toBe(500);
    expect(fake.payoutDeletes).toHaveLength(1);
    expect(fake.invoiceUpdates[0]).toMatchObject({ payment_claim: null });
    expect(settleInvoicePayment).not.toHaveBeenCalled();
  });

  it("KEEPS the claim when the move's outcome is unknown, and says so", async () => {
    // The move is one RPC: a throw is a lost response, so it may have COMMITTED.
    // Releasing would free the bank rail - which shares no idempotency key with
    // the balance move - and pay the vendor twice.
    moveResult.throws = true;
    const res = await call();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "PAYMENT_STATUS_UNKNOWN" });
    expect(fake.payoutDeletes).toEqual([]);
    expect(fake.invoiceUpdates).toEqual([]);
    expect(settleInvoicePayment).not.toHaveBeenCalled();
  });

  it("keeps the claim once the money HAS moved", async () => {
    moveResult.value = { ok: true };
    const res = await call();
    expect(res.status).toBe(200);
    expect(fake.payoutDeletes).toEqual([]);
    expect(settleInvoicePayment).toHaveBeenCalledOnce();
  });
});
