import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Wiring proof for VENDOR_BANKING_ENABLED item 1: the manager's vendor-pay
 * Checkout (work-order-approve-pay.server.ts's startVendorPayCheckout) must
 * pass PropLane's vendor take rate through to createAxisAchCheckoutSession as
 * `extraApplicationFeeCents`, and it must be exactly 0 with the flag off. The
 * dollar math itself (floor to cent, never negative, application_fee_amount
 * = Stripe's cost + this) is proven separately by platform-fees.test.ts and
 * stripe-axis-ach-checkout.test.ts; this only proves the two are connected.
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
vi.mock("@/lib/stripe-connect", () => ({
  resolveConnectDestinationIfReady: vi.fn().mockResolvedValue("acct_vendor_ready"),
}));
vi.mock("@/lib/app-url", () => ({ resolveShareableAppOrigin: () => "https://app.test" }));
vi.mock("@/lib/stripe", () => ({ getStripe: () => ({}) }));

const flagState = vi.hoisted(() => ({ enabled: false }));
vi.mock("@/lib/vendor-banking/flag", () => ({
  vendorBankingEnabled: () => flagState.enabled,
}));

const createAxisAchCheckoutSession = vi.hoisted(() =>
  vi.fn(async (_stripe: unknown, input: { amountCents?: number; platformFeeCents?: number }) => {
    const subtotalCents = input.amountCents ?? 0;
    const processingFeeCents = 100; // fixed fake Stripe cost for this test
    return {
      mode: "hosted" as const,
      url: "https://checkout.stripe.test/x",
      sessionId: "cs_test_123",
      subtotalCents,
      processingFeeCents,
      axisFeeCents: 0,
      platformFeeCents: 0,
      totalCents: subtotalCents + processingFeeCents,
      paymentMethod: "ach" as const,
    };
  }),
);
vi.mock("@/lib/stripe-axis-ach-checkout", async (orig) => {
  const actual = await orig<typeof import("@/lib/stripe-axis-ach-checkout")>();
  return { ...actual, createAxisAchCheckoutSession };
});

const authState: { ctx: unknown } = { ctx: null };
vi.mock("@/lib/reports/auth", () => ({
  getReportsAuthContext: vi.fn(async () => authState.ctx),
  assertManagerFinancialsAccess: vi.fn(async () => ({ ok: true })),
}));

import { POST } from "@/app/api/portal/work-orders/approve-pay/route";

type Row = Record<string, unknown>;

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  private mode: "select" | "insert" | "upsert" | "update" = "select";
  private payload: Row | null = null;
  constructor(
    private rows: Row[],
    private table: string,
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
  update(row: Row) {
    this.mode = "update";
    this.payload = row;
    return this;
  }
  private exec() {
    if (this.mode === "insert" || this.mode === "upsert") {
      this.rows.push({ id: `${this.table}_${this.rows.length + 1}`, ...this.payload! });
      return { data: null, error: null };
    }
    if (this.mode === "update") {
      for (const r of this.rows) {
        if (this.filters.every(([c, v]) => r[c] === v)) Object.assign(r, this.payload);
      }
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

function makeDb(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      if (!tables[table]) tables[table] = [];
      return new FakeQuery(tables[table]!, table);
    },
  };
}

const MANAGER = "manager_a";
const VENDOR = "vendor_1";
const WORK_ORDER = "wo_fee_wiring_1";
const workOrderRow = { id: WORK_ORDER, title: "Fix the boiler", propertyId: "prop_1", bucket: "completed" };

function baseTables(): Record<string, Row[]> {
  return {
    portal_work_order_records: [
      { id: WORK_ORDER, manager_user_id: MANAGER, vendor_user_id: VENDOR, row_data: workOrderRow },
    ],
    work_order_bids: [],
    vendor_payouts: [],
    audit_log: [],
  };
}

function postBody(vendorCostCents: number) {
  return new Request("http://localhost/api/portal/work-orders/approve-pay", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workOrder: workOrderRow, category: "plumbing", vendorCostCents }),
  });
}

function signIn(db: ReturnType<typeof makeDb>) {
  authState.ctx = { role: "manager", userId: MANAGER, email: "manager@axis.test", db };
}

describe("startVendorPayCheckout — vendor pay fee wiring", () => {
  beforeEach(() => {
    authState.ctx = null;
    flagState.enabled = false;
    createAxisAchCheckoutSession.mockClear();
  });

  it("flag OFF: extraApplicationFeeCents is 0 and metadata.platform_fee_cents is '0'", async () => {
    const db = makeDb(baseTables());
    signIn(db);
    flagState.enabled = false;

    const res = await POST(postBody(12_500));
    expect(res.status).toBe(200);
    expect(createAxisAchCheckoutSession).toHaveBeenCalledTimes(1);
    const call = createAxisAchCheckoutSession.mock.calls[0]![1] as Record<string, unknown>;
    expect(call.extraApplicationFeeCents).toBe(0);
    expect((call.metadata as Record<string, string>).platform_fee_cents).toBe("0");
  });

  it("flag ON: extraApplicationFeeCents is exactly 3% of the invoice, floored", async () => {
    const db = makeDb(baseTables());
    signIn(db);
    flagState.enabled = true;

    const res = await POST(postBody(12_500)); // 3% of $125.00 = $3.75 -> 375c
    expect(res.status).toBe(200);
    const call = createAxisAchCheckoutSession.mock.calls[0]![1] as Record<string, unknown>;
    expect(call.extraApplicationFeeCents).toBe(375);
    expect((call.metadata as Record<string, string>).platform_fee_cents).toBe("375");
  });

  it("flag ON, a non-round-cent 3%: floors rather than rounds up", async () => {
    const db = makeDb(baseTables());
    signIn(db);
    flagState.enabled = true;

    const res = await POST(postBody(3_333)); // 3% of $33.33 = 99.99c -> floors to 99
    expect(res.status).toBe(200);
    const call = createAxisAchCheckoutSession.mock.calls[0]![1] as Record<string, unknown>;
    expect(call.extraApplicationFeeCents).toBe(99);
  });
});
