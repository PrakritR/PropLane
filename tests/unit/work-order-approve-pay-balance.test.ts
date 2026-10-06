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

// The default (card / ACH) path now STARTS an embedded Stripe Checkout and
// settles only on the verified webhook. Stripe itself is never reached: the
// stripe layer is stubbed and every call is recorded.
const createCheckout = vi.fn();
vi.mock("@/lib/stripe", () => ({ getStripe: () => ({ checkout: { sessions: { retrieve: vi.fn() } } }) }));
vi.mock("@/lib/stripe-axis-ach-checkout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stripe-axis-ach-checkout")>()),
  createAxisAchCheckoutSession: (...args: unknown[]) => createCheckout(...args),
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
    return { data: this.rows.filter((r) => this.filters.every(([c, v]) => r[c] === v)), error: null };
  }
  maybeSingle() {
    const res = this.exec();
    return Promise.resolve({ data: Array.isArray(res.data) ? (res.data[0] ?? null) : null, error: null });
  }
  then<T>(resolve: (v: { data: unknown; error: null }) => T) {
    return Promise.resolve(this.exec()).then(resolve);
  }
}

type RpcCall = { name: string; args: Record<string, unknown> };
type RpcOverride = (name: string, args: Record<string, unknown>) => { data: unknown; error: { message: string } | null } | undefined;

function makeDb(tables: Record<string, Row[]>, rpcOverride?: RpcOverride) {
  const log = {
    inserts: [] as Array<{ table: string; row: Row }>,
    upserts: [] as Array<{ table: string; row: Row }>,
    rpcs: [] as RpcCall[],
  };
  return {
    log,
    // Claim / release / finish / paid-merge RPCs from migration 20261004220000, as ledger-free stubs.
    async rpc(name: string, args: Record<string, unknown>) {
      log.rpcs.push({ name, args });
      const overridden = rpcOverride?.(name, args);
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
const VENDOR = "vendor_1";
const WORK_ORDER = "wo_balance_1";
const workOrderRow = { id: WORK_ORDER, title: "Fix the boiler", propertyId: "prop_1", bucket: "completed", vendorCostCents: 12_500 };

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
    createCheckout.mockReset();
    createCheckout.mockImplementation(async (_stripe: unknown, req: { fixedFeeBreakdown: { totalCents: number; residentAddedFeeCents: number } }) => ({
      mode: "embedded",
      clientSecret: "cs_secret_1",
      sessionId: "cs_test_1",
      totalCents: req.fixedFeeBreakdown.totalCents,
      processingFeeCents: req.fixedFeeBreakdown.residentAddedFeeCents,
    }));
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
    // Refused before the claim: nothing was claimed, so there is nothing to release.
    expect(db.log.rpcs).toEqual([]);
  });

  it("flag ON: pays instantly from the balance, marks the work order paid with channel 'balance', records a settled payout with no Stripe transfer id", async () => {
    const db = makeDb(baseTables());
    signIn(db);
    flagState.enabled = true;
    let rpcsAtLedgerCall: string[] = [];
    payVendorFromBalance.mockImplementation(async () => {
      rpcsAtLedgerCall = db.log.rpcs.map((r) => r.name);
      return { ok: true, payerEntryId: "e-out", payeeEntryId: "e-in" };
    });

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
    expect(body).not.toHaveProperty("clientSecret");
    expect(createCheckout).not.toHaveBeenCalled();

    // The service is claimed BEFORE the ledger moves, then marked paid through the RPC.
    const names = db.log.rpcs.map((r) => r.name);
    expect(names).toEqual(["claim_work_order_vendor_payment", "mark_work_order_payment_paid"]);
    expect(db.log.rpcs[0]!.args).toMatchObject({
      p_work_order: WORK_ORDER, p_manager: MANAGER, p_vendor: VENDOR, p_amount: 12_500, p_channel: "balance",
    });
    expect(db.log.rpcs[1]!.args).toMatchObject({
      p_work_order: WORK_ORDER, p_manager: MANAGER, p_vendor: VENDOR, p_amount: 12_500, p_channel: "balance", p_session: null,
    });
    expect(rpcsAtLedgerCall).toEqual(["claim_work_order_vendor_payment"]);
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
    // The claim taken before the ledger attempt is released so the card path is free again.
    expect(db.log.rpcs.map((r) => r.name)).toEqual(["claim_work_order_vendor_payment", "release_work_order_balance_claim"]);
    expect(db.log.rpcs[1]!.args).toEqual({ p_work_order: WORK_ORDER, p_manager: MANAGER });
  });

  it("flag ON, short balance but the release RPC fails: 503, never a 422 that invites a card retry over a live claim", async () => {
    const db = makeDb(baseTables(), (name) =>
      name === "release_work_order_balance_claim" ? { data: null, error: { message: "boom" } } : undefined,
    );
    signIn(db);
    flagState.enabled = true;
    payVendorFromBalance.mockResolvedValue({
      ok: false, code: "insufficient_balance", availableCents: 5_000, requestedCents: 12_500, shortfallCents: 7_500,
    });
    const res = await POST(postBody({ paymentChannel: "balance" }));
    expect(res.status).toBe(503);
    expect(recordVendorPayoutSettled).not.toHaveBeenCalled();
  });

  it("flag ON, any OTHER ledger failure: 503 'being reconciled', the claim is KEPT (no release) and nothing is marked paid", async () => {
    const db = makeDb(baseTables());
    signIn(db);
    flagState.enabled = true;
    payVendorFromBalance.mockResolvedValue({ ok: false, code: "ledger_error", error: "timeout" });
    const res = await POST(postBody({ paymentChannel: "balance" }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toContain("reconciled");
    expect(db.log.rpcs.map((r) => r.name)).toEqual(["claim_work_order_vendor_payment"]);
    expect(recordVendorPayoutSettled).not.toHaveBeenCalled();
  });

  it("flag ON, the ledger call throws (response lost): 503, the claim is KEPT so no other rail can pay twice", async () => {
    const db = makeDb(baseTables());
    signIn(db);
    flagState.enabled = true;
    payVendorFromBalance.mockRejectedValue(new Error("socket hang up"));
    const res = await POST(postBody({ paymentChannel: "balance" }));
    expect(res.status).toBe(503);
    expect(db.log.rpcs.map((r) => r.name)).toEqual(["claim_work_order_vendor_payment"]);
  });

  it("flag ON, the service is already claimed (claim RPC refuses): 409 and the ledger is never touched", async () => {
    const db = makeDb(baseTables(), (name) =>
      name === "claim_work_order_vendor_payment" ? { data: null, error: { message: "Payment already started" } } : undefined,
    );
    signIn(db);
    flagState.enabled = true;
    const res = await POST(postBody({ paymentChannel: "balance" }));
    expect(res.status).toBe(409);
    expect(payVendorFromBalance).not.toHaveBeenCalled();
    expect(db.log.rpcs.map((r) => r.name)).toEqual(["claim_work_order_vendor_payment"]);
  });

  it("flag ON but paymentChannel omitted (default ACH): never touches the balance ledger, STARTS an embedded Checkout and settles nothing inline", async () => {
    const db = makeDb(baseTables());
    signIn(db);
    flagState.enabled = true;
    const res = await POST(postBody());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { clientSecret?: string; sessionId?: string; expenseEntryIds: string[] };
    expect(body.clientSecret).toBe("cs_secret_1");
    expect(body.sessionId).toBe("cs_test_1");
    expect(body.expenseEntryIds).toEqual([]);

    expect(payVendorFromBalance).not.toHaveBeenCalled();
    // Payment is settled only by the verified webhook/verify: no paid-merge, no payout row, no inline bookkeeping.
    expect(db.log.rpcs.map((r) => r.name)).toEqual(["claim_work_order_vendor_payment", "finish_work_order_vendor_checkout"]);
    expect(db.log.rpcs[0]!.args).toMatchObject({
      p_work_order: WORK_ORDER, p_manager: MANAGER, p_vendor: VENDOR, p_amount: 12_500, p_channel: "ach",
    });
    expect(db.log.rpcs[1]!.args).toMatchObject({ p_work_order: WORK_ORDER, p_manager: MANAGER, p_session: "cs_test_1" });
    expect(recordVendorPayoutSettled).not.toHaveBeenCalled();
    expect(db.log.upserts).toEqual([]);

    expect(createCheckout).toHaveBeenCalledTimes(1);
    expect(createCheckout.mock.calls[0]![1]).toMatchObject({
      mode: "embedded",
      amountCents: 12_500,
      paymentMethod: "ach",
      destinationAccountId: null,
      metadata: expect.objectContaining({ work_order_id: WORK_ORDER, manager_user_id: MANAGER, vendor_user_id: VENDOR, invoice_cents: "12500" }),
    });
  });

  it("the payable comes from the stored row, not the request body: a forged cost, vendor and materials change nothing", async () => {
    const db = makeDb(baseTables());
    signIn(db);
    const res = await POST(
      postBody({
        paymentChannel: "card",
        vendorCostCents: 999_999,
        materialsCostCents: 50_000,
        workOrder: { ...workOrderRow, vendorCostCents: 999_999, vendorUserId: "attacker", propertyId: "prop_evil" },
      }),
    );
    expect(res.status).toBe(200);
    expect(db.log.rpcs[0]).toMatchObject({
      name: "claim_work_order_vendor_payment",
      args: { p_vendor: VENDOR, p_amount: 12_500, p_channel: "card" },
    });
    const req = createCheckout.mock.calls[0]![1] as { amountCents: number; metadata: Record<string, string>; paymentMethod: string };
    expect(req.amountCents).toBe(12_500);
    expect(req.paymentMethod).toBe("card");
    expect(req.metadata.vendor_user_id).toBe(VENDOR);
    // Materials are not part of the payable: the Checkout total is the labor cost alone.
    expect(req.metadata.invoice_cents).toBe("12500");
  });

  it("an accepted bid's labor cost wins over the stored row cost", async () => {
    const tables = baseTables();
    tables.work_order_bids = [{ work_order_id: WORK_ORDER, status: "accepted", amount_cents: 20_000, materials_cents: 3_000, vendor_directory_id: "vd_1" }];
    const db = makeDb(tables);
    signIn(db);
    const res = await POST(postBody({ paymentChannel: "ach" }));
    expect(res.status).toBe(200);
    expect(db.log.rpcs[0]!.args).toMatchObject({ p_amount: 20_000 });
    expect((createCheckout.mock.calls[0]![1] as { amountCents: number }).amountCents).toBe(20_000);
  });

  it("a service with no assigned vendor or under $1.00 is refused 400 before any claim or Stripe call", async () => {
    const tables = baseTables();
    tables.portal_work_order_records = [{ id: WORK_ORDER, manager_user_id: MANAGER, vendor_user_id: null, row_data: workOrderRow }];
    const db = makeDb(tables);
    signIn(db);
    const res = await POST(postBody());
    expect(res.status).toBe(400);
    expect(db.log.rpcs).toEqual([]);
    expect(createCheckout).not.toHaveBeenCalled();
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
});
