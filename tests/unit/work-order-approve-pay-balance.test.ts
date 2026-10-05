import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * night/vendor-pay: "Pay from PropLane balance" as a payment source on the
 * manager's real "Approve + Pay" action (work orders), behind
 * PROPLANE_BALANCE_ENABLED. Reuses payVendorFromBalance (the same ledger move
 * the vendor-invoice pay-from-balance route uses), the SAME double-pay guard
 * the ACH path already has, and the SAME assertManagerFinancialsAccess gate.
 */
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/stripe-vendor-payout", () => ({
  payoutVendorForWorkOrder: vi.fn().mockResolvedValue({ status: "skipped", amountCents: 0 }),
  recordVendorPayoutSettled: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/work-order-events.server", () => ({ workOrderEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/co-manager-notification-recipients.server", () => ({
  resolvePropertyScopedManagerRecipientIds: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/work-order-expenses", () => ({
  createExpensesFromWorkOrder: vi.fn().mockResolvedValue(["exp_1"]),
  readPostedWorkOrderExpenseLines: vi.fn().mockResolvedValue({ ok: true, posted: new Map() }),
  mergeWorkOrderCompletion: vi.fn((row: Record<string, unknown>) => ({ ...row, bucket: "completed" })),
  markWorkOrderPaid: vi.fn((row: Record<string, unknown>, paidAt: string, opts: { channel: string }) => ({
    ...row,
    automationStatus: "paid",
    paidAt,
    vendorPaymentChannel: opts.channel,
  })),
}));

const flagState: { enabled: boolean } = { enabled: false };
vi.mock("@/lib/proplane-balance/flag", () => ({
  proplaneBalanceEnabled: () => flagState.enabled,
}));

const payVendorFromBalance = vi.fn();
vi.mock("@/lib/proplane-balance/ledger.server", () => ({
  payVendorFromBalance: (...args: unknown[]) => payVendorFromBalance(...args),
}));

const authState: { ctx: unknown } = { ctx: null };
vi.mock("@/lib/reports/auth", () => ({
  getReportsAuthContext: vi.fn(async () => authState.ctx),
  assertManagerFinancialsAccess: vi.fn(async () => ({ ok: true })),
}));

import { POST } from "@/app/api/portal/work-orders/approve-pay/route";
import { recordVendorPayoutSettled } from "@/lib/stripe-vendor-payout";

type Row = Record<string, unknown>;

/** Same fake query builder as work-order-approve-pay-double-pay-guard.test.ts. */
class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  private mode: "select" | "insert" | "upsert" | "delete" = "select";
  private payload: Row | null = null;
  constructor(
    private rows: Row[],
    private table: string,
    private log: { inserts: Array<{ table: string; row: Row }>; upserts: Array<{ table: string; row: Row }> },
  ) {}
  select() {
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push([col, val]);
    return this;
  }
  in(col: string, vals: unknown[]) {
    this.filters.push([col, vals]);
    return this;
  }
  insert(row: Row) {
    this.mode = "insert";
    this.payload = row;
    return this;
  }
  delete() {
    this.mode = "delete";
    return this;
  }
  is(col: string, val: unknown) {
    this.filters.push([col, val]);
    return this;
  }
  upsert(row: Row) {
    this.mode = "upsert";
    this.payload = row;
    return this;
  }
  private exec() {
    if (this.mode === "insert") {
      this.log.inserts.push({ table: this.table, row: this.payload! });
      const inserted = { id: `${this.table}_${this.rows.length + 1}`, ...this.payload! };
      this.rows.push(inserted);
      return { data: inserted, error: null };
    }
    if (this.mode === "delete") {
      for (const hit of this.rows.filter((r) => this.filters.every(([c, v]) => (Array.isArray(v) ? v.includes(r[c]) : r[c] === v)))) this.rows.splice(this.rows.indexOf(hit), 1);
      return { data: null, error: null };
    }
    if (this.mode === "upsert") {
      this.log.upserts.push({ table: this.table, row: this.payload! });
      return { data: null, error: null };
    }
    return { data: this.rows.filter((r) => this.filters.every(([c, v]) => (Array.isArray(v) ? v.includes(r[c]) : r[c] === v))), error: null };
  }
  maybeSingle() {
    const res = this.exec();
    return Promise.resolve({ data: Array.isArray(res.data) ? (res.data[0] ?? null) : res.data, error: null });
  }
  then<T>(resolve: (v: { data: unknown; error: null }) => T) {
    return Promise.resolve(this.exec()).then(resolve);
  }
}

function makeDb(tables: Record<string, Row[]>) {
  const log = { inserts: [] as Array<{ table: string; row: Row }>, upserts: [] as Array<{ table: string; row: Row }> };
  return {
    log,
    from(table: string) {
      if (!tables[table]) tables[table] = [];
      return new FakeQuery(tables[table]!, table, log);
    },
  };
}

const MANAGER = "manager_a";
const VENDOR = "vendor_1";
const WORK_ORDER = "wo_balance_1";
const workOrderRow = { id: WORK_ORDER, title: "Fix the boiler", propertyId: "prop_1", bucket: "completed" };

function baseTables(payout?: Row): Record<string, Row[]> {
  return {
    portal_work_order_records: [
      { id: WORK_ORDER, manager_user_id: MANAGER, vendor_user_id: VENDOR, row_data: workOrderRow },
    ],
    work_order_bids: [],
    vendor_payouts: payout ? [payout] : [],
    audit_log: [],
  };
}

function postBody(extra: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/portal/work-orders/approve-pay", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workOrder: workOrderRow, category: "plumbing", vendorCostCents: 12_500, ...extra }),
  });
}

function signIn(db: ReturnType<typeof makeDb>) {
  authState.ctx = { role: "manager", userId: MANAGER, email: "manager@axis.test", db };
}

describe("approve-pay — PropLane balance payment source", () => {
  beforeEach(() => {
    authState.ctx = null;
    flagState.enabled = false;
    payVendorFromBalance.mockReset();
    vi.mocked(recordVendorPayoutSettled).mockClear();
  });

  it("flag OFF: paymentChannel 'balance' is refused (400), never calls the ledger", async () => {
    const db = makeDb(baseTables());
    signIn(db);
    flagState.enabled = false;
    const res = await POST(postBody({ paymentChannel: "balance" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("not enabled");
    expect(payVendorFromBalance).not.toHaveBeenCalled();
    expect(db.log.upserts).toEqual([]);
  });

  it("flag ON: pays instantly from the balance, marks the work order paid with channel 'balance', records a settled payout with no Stripe transfer id", async () => {
    const db = makeDb(baseTables());
    signIn(db);
    flagState.enabled = true;
    payVendorFromBalance.mockResolvedValue({ ok: true, payerEntryId: "e-out", payeeEntryId: "e-in" });

    const res = await POST(postBody({ paymentChannel: "balance" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workOrder: Row };
    expect(body.workOrder.vendorPaymentChannel).toBe("balance");

    expect(payVendorFromBalance).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ managerUserId: MANAGER, vendorUserId: VENDOR, amountCents: 12_500, idempotencyRoot: `work-order:${WORK_ORDER}` }),
    );
    expect(recordVendorPayoutSettled).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ workOrderId: WORK_ORDER, managerUserId: MANAGER, vendorUserId: VENDOR, amountCents: 12_500, stripeTransferId: null }),
    );
    // No Checkout redirect for a balance payment.
    expect(body).not.toHaveProperty("checkoutUrl");
  });

  it("flag ON, insufficient balance: 422 with the shortfall, nothing written (no expense/upsert), falls back to the card path", async () => {
    const db = makeDb(baseTables());
    signIn(db);
    flagState.enabled = true;
    payVendorFromBalance.mockResolvedValue({
      ok: false,
      code: "insufficient_balance",
      availableCents: 5_000,
      requestedCents: 12_500,
      shortfallCents: 7_500,
    });

    const res = await POST(postBody({ paymentChannel: "balance" }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      code: string;
      availableCents: number;
      requestedCents: number;
      shortfallCents: number;
      error: string;
    };
    expect(body.code).toBe("insufficient_balance");
    expect(body.availableCents).toBe(5_000);
    expect(body.requestedCents).toBe(12_500);
    expect(body.shortfallCents).toBe(7_500);
    expect(body.error).toContain("card");
    // Nothing was marked paid or booked — the manager can still pay by card.
    expect(db.log.upserts).toEqual([]);
    expect(recordVendorPayoutSettled).not.toHaveBeenCalled();
  });

  it("flag ON but paymentChannel omitted (default ACH): unaffected — never touches the balance ledger", async () => {
    const db = makeDb(baseTables());
    signIn(db);
    flagState.enabled = true;
    // settleOnly skips starting a real Stripe Checkout session (untouched by
    // this build either way) — what this test asserts is narrower and
    // independent of that: the balance ledger is never consulted when the
    // channel isn't explicitly "balance", flag on or not.
    const res = await POST(postBody({ settleOnly: true }));
    expect(res.status).toBe(200);
    expect(payVendorFromBalance).not.toHaveBeenCalled();
  });

  it("reuses the SAME double-pay guard for a balance payment: an existing paid payout refuses with 409 before any ledger call", async () => {
    const existingPayout: Row = {
      id: "payout_1",
      work_order_id: WORK_ORDER,
      status: "paid",
      amount_cents: 12_500,
      stripe_transfer_id: "tr_abc",
      created_at: "2026-09-01T17:00:00.000Z",
    };
    const db = makeDb(baseTables(existingPayout));
    signIn(db);
    flagState.enabled = true;
    const res = await POST(postBody({ paymentChannel: "balance" }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("existing_payout");
    expect(payVendorFromBalance).not.toHaveBeenCalled();
  });

  it("claims the job's payout BEFORE the money moves, and settles that same row afterwards", async () => {
    const tables = baseTables();
    const db = makeDb(tables);
    signIn(db);
    flagState.enabled = true;
    let claimedAtMove: Row[] = [];
    payVendorFromBalance.mockImplementation(async () => {
      claimedAtMove = tables.vendor_payouts!.map((r) => ({ ...r }));
      return { ok: true, payerEntryId: "e-out", payeeEntryId: "e-in" };
    });

    const res = await POST(postBody({ paymentChannel: "balance" }));
    expect(res.status).toBe(200);
    expect(claimedAtMove).toHaveLength(1);
    expect(claimedAtMove[0]).toMatchObject({ work_order_id: WORK_ORDER, status: "pending", amount_cents: 12_500 });
    expect(claimedAtMove[0]).not.toHaveProperty("invoice_id");
  });

  it("releases the claim when nothing moved, so the job can still be paid another way", async () => {
    const tables = baseTables();
    const db = makeDb(tables);
    signIn(db);
    flagState.enabled = true;
    payVendorFromBalance.mockResolvedValue({
      ok: false,
      code: "insufficient_balance",
      availableCents: 5_000,
      requestedCents: 12_500,
      shortfallCents: 7_500,
    });

    expect((await POST(postBody({ paymentChannel: "balance" }))).status).toBe(422);
    expect(tables.vendor_payouts).toEqual([]);
  });

  it("the database is the arbiter: a payout insert it refuses (another rail already paid the job) is a 409 and moves no money", async () => {
    const inner = makeDb(baseTables());
    const db = {
      log: inner.log,
      from(table: string) {
        if (table !== "vendor_payouts") return inner.from(table);
        const refused = {
          insert: () => refused,
          select: () => refused,
          maybeSingle: async () => ({ data: null, error: { code: "VP409", message: "This service already has a payout in progress or paid through another payment method. Paying it again would pay the vendor twice." } }),
          eq: () => refused,
          then: (resolve: (v: { data: Row[]; error: null }) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve),
        };
        return refused;
      },
    };
    signIn(db as never);
    flagState.enabled = true;

    const res = await POST(postBody({ paymentChannel: "balance" }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/pay the vendor twice/);
    expect(payVendorFromBalance).not.toHaveBeenCalled();
    expect(db.log.upserts).toEqual([]);
  });

  it("invoice paid first, then Approve + pay: the job's own invoice payout refuses with 409 before any ledger call", async () => {
    const db = makeDb({
      ...baseTables({ id: "payout_inv", work_order_id: WORK_ORDER, status: "pending", amount_cents: 12_500, invoice_id: "inv-job", created_at: "2026-09-01T17:00:00.000Z" }),
      vendor_invoices: [{ id: "inv-job", estimate_visit_bid_id: null }],
    });
    signIn(db);
    flagState.enabled = true;

    expect((await POST(postBody({ paymentChannel: "balance" }))).status).toBe(409);
    expect(payVendorFromBalance).not.toHaveBeenCalled();
  });
});
