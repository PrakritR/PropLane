import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The manager's "Mark as paid" on a vendor work order that ALREADY has a
 * PropLane payout: the server is the guard, and there is no override. The POST
 * is refused with a 409 naming the payout and the rail that holds it, and
 * nothing — no audit row, no bookkeeping write — is written.
 */
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/stripe-vendor-payout", () => ({
  payoutVendorForWorkOrder: vi.fn().mockResolvedValue({ status: "skipped", amountCents: 0 }),
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

const authState: { ctx: unknown } = { ctx: null };
vi.mock("@/lib/reports/auth", () => ({
  getReportsAuthContext: vi.fn(async () => authState.ctx),
  assertManagerFinancialsAccess: vi.fn(async () => ({ ok: true })),
}));

import { POST, GET } from "@/app/api/portal/work-orders/approve-pay/route";

type Row = Record<string, unknown>;

/** Table-backed chainable fake of the supabase-js builder shape this path uses. */
class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  private mode: "select" | "insert" | "upsert" = "select";
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
  is(col: string, val: unknown) {
    this.filters.push([col, val]);
    return this;
  }
  insert(row: Row) {
    this.mode = "insert";
    this.payload = row;
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
      this.rows.push({ id: `${this.table}_${this.rows.length + 1}`, ...this.payload! });
      return { data: null, error: null };
    }
    if (this.mode === "upsert") {
      this.log.upserts.push({ table: this.table, row: this.payload! });
      return { data: null, error: null };
    }
    return {
      data: this.rows.filter((r) =>
        this.filters.every(([c, v]) => (Array.isArray(v) ? v.includes(r[c]) : (r[c] ?? null) === v)),
      ),
      error: null,
    };
  }
  maybeSingle() {
    const res = this.exec();
    return Promise.resolve({ data: Array.isArray(res.data) ? (res.data[0] ?? null) : null, error: null });
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
const WORK_ORDER = "wo_1";
const workOrderRow = {
  id: WORK_ORDER,
  title: "Fix the boiler",
  propertyId: "prop_1",
  vendorCostCents: 12_500,
  bucket: "completed",
};

function baseTables(payout?: Row): Record<string, Row[]> {
  return {
    portal_work_order_records: [
      { id: WORK_ORDER, manager_user_id: MANAGER, vendor_user_id: "vendor_1", row_data: workOrderRow },
    ],
    work_order_bids: [],
    vendor_payouts: payout ? [payout] : [],
    audit_log: [],
  };
}

const paidPayout: Row = {
  id: "payout_1",
  work_order_id: WORK_ORDER,
  status: "paid",
  amount_cents: 12_500,
  stripe_transfer_id: "tr_abc",
  created_at: "2026-09-01T17:00:00.000Z",
};

function postBody(extra: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/portal/work-orders/approve-pay", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workOrder: workOrderRow, category: "plumbing", ...extra }),
  });
}

function signIn(db: ReturnType<typeof makeDb>) {
  authState.ctx = { role: "manager", userId: MANAGER, email: "manager@axis.test", db };
}

describe("approve-pay double-pay guard", () => {
  beforeEach(() => {
    authState.ctx = null;
  });

  it("refuses a mark-paid with 409 naming the existing payout when no acknowledgement is sent", async () => {
    const db = makeDb(baseTables(paidPayout));
    signIn(db);
    const res = await POST(postBody());
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string; existingPayout: Row };
    expect(body.code).toBe("existing_payout");
    expect(body.existingPayout).toMatchObject({
      id: "payout_1",
      status: "paid",
      amountCents: 12_500,
      stripeTransferId: "tr_abc",
      rail: "approve_pay",
    });
    expect(body.error).toContain("payout_1");
    expect(body.error).toContain("tr_abc");
    expect(body.error).toContain("Approve + pay");
    // Nothing was written: no audit row, no work-order upsert.
    expect(db.log.inserts).toEqual([]);
    expect(db.log.upserts).toEqual([]);
  });

  it("there is no acknowledgement override: the refusal stands however the client asks", async () => {
    for (const ack of [true, "yes", 1]) {
      const db = makeDb(baseTables(paidPayout));
      signIn(db);
      const res = await POST(postBody({ acknowledgeExistingPayout: ack }));
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe("existing_payout");
      // No `vendor_double_pay_acknowledged` audit row for a payment that can never happen.
      expect(db.log.inserts).toEqual([]);
      expect(db.log.upserts).toEqual([]);
    }
  });

  it("settleOnly is not a client-reachable escape hatch: the route strips it and the guard still refuses", async () => {
    // `settleOnly` skips the guard because it records a payment the Stripe webhook already took.
    // The route builds the core's input from an allowlist, so the body can never set it.
    const db = makeDb(baseTables(paidPayout));
    signIn(db);
    const res = await POST(postBody({ settleOnly: true }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("existing_payout");
    expect(db.log.inserts).toEqual([]);
    expect(db.log.upserts).toEqual([]);
  });

  it("names the vendor's invoice as the rail when the blocking payout belongs to one", async () => {
    const tables = baseTables({ ...paidPayout, invoice_id: "inv_1" });
    tables.vendor_invoices = [{ id: "inv_1", estimate_visit_bid_id: null }];
    const db = makeDb(tables);
    signIn(db);
    const res = await POST(postBody());
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; existingPayout: Row };
    expect(body.existingPayout).toMatchObject({ rail: "invoice" });
    expect(body.error).toContain("invoice");
  });

  it("also blocks on a pending (in-flight) payout", async () => {
    const db = makeDb(baseTables({ ...paidPayout, status: "pending", stripe_transfer_id: null }));
    signIn(db);
    const res = await POST(postBody());
    expect(res.status).toBe(409);
    expect(((await res.json()) as { existingPayout: Row }).existingPayout).toMatchObject({ status: "pending" });
  });

  it("does not block, and writes no acknowledgement, when the only payout failed or was skipped", async () => {
    for (const status of ["failed", "skipped"]) {
      const db = makeDb(baseTables({ ...paidPayout, status, stripe_transfer_id: null }));
      signIn(db);
      const res = await POST(postBody());
      expect(res.status).toBe(200);
      expect(db.log.inserts.filter((i) => i.table === "audit_log")).toEqual([]);
    }
  });

  it("does not block a work order with no payout at all", async () => {
    const db = makeDb(baseTables());
    signIn(db);
    const res = await POST(postBody());
    expect(res.status).toBe(200);
    expect(db.log.inserts.filter((i) => i.table === "audit_log")).toEqual([]);
  });

  it("GET pre-check reports the blocking payout for the owner and nothing for a stranger", async () => {
    const db = makeDb(baseTables(paidPayout));
    signIn(db);
    const ok = await GET(new Request(`http://localhost/api/portal/work-orders/approve-pay?workOrderId=${WORK_ORDER}`));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { existingPayout: Row }).existingPayout).toMatchObject({ id: "payout_1", status: "paid", rail: "approve_pay" });

    authState.ctx = { role: "manager", userId: "manager_b", email: "b@axis.test", db };
    const forbidden = await GET(new Request(`http://localhost/api/portal/work-orders/approve-pay?workOrderId=${WORK_ORDER}`));
    expect(forbidden.status).toBe(403);
  });
});
