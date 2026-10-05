import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The manager's "Mark as paid" on a vendor work order that ALREADY has a
 * PropLane payout: the server is the guard. Without the acknowledgement the
 * POST is refused with a 409 naming the payout; with it, the acknowledgement
 * is written to audit_log before any bookkeeping write.
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
  mergeWorkOrderCompletion: vi.fn((row: Record<string, unknown>) => ({ ...row, bucket: "completed" })),
  markWorkOrderPaid: vi.fn((row: Record<string, unknown>, paidAt: string, opts: { channel: string }) => ({
    ...row,
    automationStatus: "paid",
    paidAt,
    vendorPaymentChannel: opts.channel,
  })),
}));

// An approved pay now STARTS an embedded Stripe Checkout and settles only on the
// verified webhook. Stripe is never reached: the stripe layer is stubbed and
// every call recorded, so "checkout started" and "no inline settle" are asserted.
const createCheckout = vi.fn();
vi.mock("@/lib/stripe", () => ({ getStripe: () => ({ checkout: { sessions: { retrieve: vi.fn() } } }) }));
vi.mock("@/lib/stripe-axis-ach-checkout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stripe-axis-ach-checkout")>()),
  createAxisAchCheckoutSession: (...args: unknown[]) => createCheckout(...args),
}));

const authState: { ctx: unknown } = { ctx: null };
vi.mock("@/lib/reports/auth", () => ({
  getReportsAuthContext: vi.fn(async () => authState.ctx),
  assertManagerFinancialsAccess: vi.fn(async () => ({ ok: true })),
}));

import { POST, GET } from "@/app/api/portal/work-orders/approve-pay/route";

type Row = Record<string, unknown>;
type DbLog = {
  inserts: Array<{ table: string; row: Row }>;
  upserts: Array<{ table: string; row: Row }>;
  rpcs: Array<{ name: string; args: Row }>;
  /** Every write and RPC in the order it happened. */
  order: string[];
  failInsertOn: string | null;
};

/** Table-backed chainable fake of the supabase-js builder shape this path uses. */
class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  private mode: "select" | "insert" | "upsert" = "select";
  private payload: Row | null = null;
  constructor(
    private rows: Row[],
    private table: string,
    private log: DbLog,
  ) {}
  select() {
    return this;
  }
  eq(col: string, val: unknown) {
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
  private exec(): { data: unknown; error: { message: string } | null } {
    if (this.mode === "insert") {
      if (this.log.failInsertOn === this.table) return { data: null, error: { message: "insert refused" } };
      this.log.inserts.push({ table: this.table, row: this.payload! });
      this.log.order.push(`insert:${this.table}`);
      this.rows.push({ id: `${this.table}_${this.rows.length + 1}`, ...this.payload! });
      return { data: null, error: null };
    }
    if (this.mode === "upsert") {
      this.log.upserts.push({ table: this.table, row: this.payload! });
      this.log.order.push(`upsert:${this.table}`);
      return { data: null, error: null };
    }
    return { data: this.rows.filter((r) => this.filters.every(([c, v]) => r[c] === v)), error: null };
  }
  maybeSingle() {
    const res = this.exec();
    return Promise.resolve({ data: Array.isArray(res.data) ? (res.data[0] ?? null) : null, error: res.error });
  }
  then<T>(resolve: (v: { data: unknown; error: { message: string } | null }) => T) {
    return Promise.resolve(this.exec()).then(resolve);
  }
}

function makeDb(tables: Record<string, Row[]>, rpcOverride?: (name: string) => { data: unknown; error: { message: string } | null } | undefined) {
  const log: DbLog = { inserts: [], upserts: [], rpcs: [], order: [], failInsertOn: null };
  return {
    log,
    // Claim / finish / paid-merge RPCs from migration 20261004220000, as ledger-free stubs.
    async rpc(name: string, args: Row) {
      log.rpcs.push({ name, args });
      log.order.push(`rpc:${name}`);
      const overridden = rpcOverride?.(name);
      if (overridden) return overridden;
      if (name === "mark_work_order_payment_paid") return { data: args.p_patch, error: null };
      if (name === "finish_work_order_vendor_checkout") return { data: true, error: null };
      return { data: null, error: null };
    },
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
    createCheckout.mockReset();
    createCheckout.mockImplementation(async (_stripe: unknown, req: { fixedFeeBreakdown: { totalCents: number; residentAddedFeeCents: number } }) => ({
      mode: "embedded",
      clientSecret: "cs_secret_1",
      sessionId: "cs_test_1",
      totalCents: req.fixedFeeBreakdown.totalCents,
      processingFeeCents: req.fixedFeeBreakdown.residentAddedFeeCents,
    }));
  });

  it("refuses a mark-paid with 409 naming the existing payout when no acknowledgement is sent", async () => {
    const db = makeDb(baseTables(paidPayout));
    signIn(db);
    const res = await POST(postBody());
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string; existingPayout: Row };
    expect(body.code).toBe("existing_payout");
    expect(body.existingPayout).toMatchObject({ id: "payout_1", status: "paid", amountCents: 12_500, stripeTransferId: "tr_abc" });
    expect(body.error).toContain("payout_1");
    expect(body.error).toContain("tr_abc");
    // Nothing was written: no audit row, no work-order upsert.
    expect(db.log.inserts).toEqual([]);
    expect(db.log.upserts).toEqual([]);
    // No claim, no Checkout: the refusal happens before any money-moving step.
    expect(db.log.rpcs).toEqual([]);
    expect(createCheckout).not.toHaveBeenCalled();
  });

  it("treats a truthy-but-not-true acknowledgement as absent", async () => {
    const db = makeDb(baseTables(paidPayout));
    signIn(db);
    const res = await POST(postBody({ acknowledgeExistingPayout: "yes" }));
    expect(res.status).toBe(409);
    expect(db.log.inserts).toEqual([]);
    expect(db.log.rpcs).toEqual([]);
    expect(createCheckout).not.toHaveBeenCalled();
  });

  it("also blocks on a pending (in-flight) payout", async () => {
    const db = makeDb(baseTables({ ...paidPayout, status: "pending", stripe_transfer_id: null }));
    signIn(db);
    const res = await POST(postBody());
    expect(res.status).toBe(409);
    expect(((await res.json()) as { existingPayout: Row }).existingPayout).toMatchObject({ status: "pending" });
    expect(db.log.rpcs).toEqual([]);
    expect(createCheckout).not.toHaveBeenCalled();
  });

  it("proceeds with the acknowledgement: the audit event is written FIRST, naming actor, work order and payout, then the claim and an embedded Checkout start (no inline settle)", async () => {
    const db = makeDb(baseTables(paidPayout));
    signIn(db);
    const res = await POST(postBody({ acknowledgeExistingPayout: true }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { clientSecret?: string; sessionId?: string; expenseEntryIds: string[] };
    expect(body.clientSecret).toBe("cs_secret_1");
    expect(body.sessionId).toBe("cs_test_1");

    const audit = db.log.inserts.filter((i) => i.table === "audit_log");
    expect(audit).toHaveLength(1);
    expect(audit[0]!.row).toMatchObject({
      action: "vendor_double_pay_acknowledged",
      actor_user_id: MANAGER,
      landlord_id: MANAGER,
      input_summary: { workOrderId: WORK_ORDER, payoutId: "payout_1", payoutStatus: "paid", paymentChannel: "ach" },
    });
    // The acknowledgement is on record before the claim and before any Stripe call.
    expect(db.log.order).toEqual([
      "insert:audit_log",
      "rpc:claim_work_order_vendor_payment",
      "rpc:finish_work_order_vendor_checkout",
    ]);
    expect(createCheckout).toHaveBeenCalledTimes(1);
    // Payment is settled only by the verified webhook: no paid-merge, no work-order write.
    expect(db.log.rpcs.some((r) => r.name === "mark_work_order_payment_paid")).toBe(false);
    expect(db.log.upserts).toEqual([]);
  });

  it("an acknowledged pay the database claim still refuses (a pending/paid payout row exists) ends 409 with the ack on record and NO Checkout started", async () => {
    const db = makeDb(baseTables(paidPayout), (name) =>
      name === "claim_work_order_vendor_payment" ? { data: null, error: { message: "Service payout already exists" } } : undefined,
    );
    signIn(db);
    const res = await POST(postBody({ acknowledgeExistingPayout: true }));
    expect(res.status).toBe(409);
    expect(db.log.inserts.filter((i) => i.table === "audit_log")).toHaveLength(1);
    expect(createCheckout).not.toHaveBeenCalled();
    expect(db.log.rpcs.some((r) => r.name === "finish_work_order_vendor_checkout")).toBe(false);
  });

  it("a failed acknowledgement write refuses 500: nothing is claimed and no Checkout starts", async () => {
    const db = makeDb(baseTables(paidPayout));
    db.log.failInsertOn = "audit_log";
    signIn(db);
    const res = await POST(postBody({ acknowledgeExistingPayout: true }));
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain("nothing was marked paid");
    expect(db.log.rpcs).toEqual([]);
    expect(createCheckout).not.toHaveBeenCalled();
  });

  it("does not block, and writes no acknowledgement, when the only payout failed or was skipped: Checkout starts", async () => {
    for (const status of ["failed", "skipped"]) {
      createCheckout.mockClear();
      const db = makeDb(baseTables({ ...paidPayout, status, stripe_transfer_id: null }));
      signIn(db);
      const res = await POST(postBody());
      expect(res.status).toBe(200);
      expect(((await res.json()) as { clientSecret?: string }).clientSecret).toBe("cs_secret_1");
      expect(db.log.inserts.filter((i) => i.table === "audit_log")).toEqual([]);
      expect(db.log.rpcs[0]!.name).toBe("claim_work_order_vendor_payment");
      expect(createCheckout).toHaveBeenCalledTimes(1);
    }
  });

  it("does not block a work order with no payout at all: Checkout starts, nothing settles inline", async () => {
    const db = makeDb(baseTables());
    signIn(db);
    const res = await POST(postBody());
    expect(res.status).toBe(200);
    expect(((await res.json()) as { clientSecret?: string }).clientSecret).toBe("cs_secret_1");
    expect(db.log.inserts.filter((i) => i.table === "audit_log")).toEqual([]);
    expect(createCheckout).toHaveBeenCalledTimes(1);
    expect(db.log.rpcs.some((r) => r.name === "mark_work_order_payment_paid")).toBe(false);
    expect(db.log.upserts).toEqual([]);
  });

  it("GET pre-check reports the blocking payout for the owner and nothing for a stranger", async () => {
    const db = makeDb(baseTables(paidPayout));
    signIn(db);
    const ok = await GET(new Request(`http://localhost/api/portal/work-orders/approve-pay?workOrderId=${WORK_ORDER}`));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { existingPayout: Row }).existingPayout).toMatchObject({ id: "payout_1", status: "paid" });

    authState.ctx = { role: "manager", userId: "manager_b", email: "b@axis.test", db };
    const forbidden = await GET(new Request(`http://localhost/api/portal/work-orders/approve-pay?workOrderId=${WORK_ORDER}`));
    expect(forbidden.status).toBe(403);
  });
});
