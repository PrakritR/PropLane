/**
 * `claim_vendor_invoice_payment` makes one rail own the invoice so a manager
 * cannot pay the same bill twice. The claim is RELEASED (through the
 * `release_vendor_invoice_balance_claim` RPC, never a client-side delete) only
 * when the database definitively said no money moved: an insufficient balance.
 * Any other ledger failure is ambiguous - the debit may have committed with the
 * response lost - so the claim is KEPT (503, "being reconciled") rather than
 * freeing the bank rail, which shares no idempotency key with the balance move.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const moveResult: { value: unknown; throws: boolean } = { value: null, throws: false };
const payVendorFromBalance = vi.fn(async () => {
  if (moveResult.throws) throw new Error("ledger unavailable");
  return moveResult.value;
});
const claimInvoicePayment = vi.fn(async (..._a: unknown[]) => undefined);
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

/** Records direct client-side writes (there must be none) and every RPC. */
const fake = {
  db: null as unknown,
  payoutDeletes: [] as Row[][],
  invoiceUpdates: [] as Row[],
  rpcs: [] as Array<{ name: string; args: Row }>,
  rpcError: null as { message: string } | null,
};

function fakeDb() {
  fake.payoutDeletes = [];
  fake.invoiceUpdates = [];
  fake.rpcs = [];
  fake.rpcError = null;
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
  const rpc = async (name: string, args: Row) => {
    fake.rpcs.push({ name, args });
    return { data: true, error: fake.rpcError };
  };
  fake.db = { from, rpc };
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
  it("claims the invoice for the balance rail BEFORE the ledger moves", async () => {
    moveResult.value = { ok: true };
    await call();
    expect(claimInvoicePayment).toHaveBeenCalledWith(fake.db, MANAGER, INVOICE, "balance");
    expect(claimInvoicePayment.mock.invocationCallOrder[0]!).toBeLessThan(payVendorFromBalance.mock.invocationCallOrder[0]!);
  });

  it("releases the claim through the RPC when the balance is short (422)", async () => {
    moveResult.value = { ok: false, code: "insufficient_balance", availableCents: 1_000, requestedCents: 25_000, shortfallCents: 24_000 };
    const res = await call();
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "insufficient_balance", availableCents: 1_000, requestedCents: 25_000, shortfallCents: 24_000 });
    expect(fake.rpcs).toEqual([{ name: "release_vendor_invoice_balance_claim", args: { p_invoice: INVOICE, p_manager: MANAGER } }]);
    // The release is the RPC's job: no client-side delete/update of payouts or the invoice.
    expect(fake.payoutDeletes).toEqual([]);
    expect(fake.invoiceUpdates).toEqual([]);
    expect(settleInvoicePayment).not.toHaveBeenCalled();
  });

  it("a short balance whose release RPC fails is a 500, never a 422 that invites another rail over a live claim", async () => {
    moveResult.value = { ok: false, code: "insufficient_balance", availableCents: 1_000, requestedCents: 25_000, shortfallCents: 24_000 };
    fake.rpcError = { message: "release refused" };
    const res = await call();
    expect(res.status).toBe(500);
    expect(settleInvoicePayment).not.toHaveBeenCalled();
  });

  it("KEEPS the claim on any OTHER ledger failure (503, being reconciled): the debit may have committed with the response lost", async () => {
    moveResult.value = { ok: false, code: "ledger_error", error: "boom" };
    const res = await call();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "PAYMENT_STATUS_UNKNOWN" });
    expect(fake.rpcs).toEqual([]);
    expect(fake.payoutDeletes).toEqual([]);
    expect(fake.invoiceUpdates).toEqual([]);
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
    expect(fake.rpcs).toEqual([]);
    expect(fake.payoutDeletes).toEqual([]);
    expect(fake.invoiceUpdates).toEqual([]);
    expect(settleInvoicePayment).not.toHaveBeenCalled();
  });

  it("keeps the claim once the money HAS moved", async () => {
    moveResult.value = { ok: true };
    const res = await call();
    expect(res.status).toBe(200);
    expect(fake.rpcs).toEqual([]);
    expect(fake.payoutDeletes).toEqual([]);
    expect(settleInvoicePayment).toHaveBeenCalledOnce();
  });
});
