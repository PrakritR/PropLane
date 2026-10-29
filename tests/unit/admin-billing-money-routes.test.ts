/**
 * The staff MONEY routes on one manager's subscription: price, refund, cancel
 * (`/api/admin/accounts/[id]/billing/(price|refund|cancel)`).
 *
 * What these pin, in order of what they cost when wrong:
 *
 * 1. **Only an Overall admin gets near Stripe.** Signed out 401; a caller without the `admin` role (a
 *    manager, or a workspace-only admin / PropLane seat holder, who never holds it) 403; a non-manager
 *    target 404. None of them reaches Stripe or writes an audit row.
 * 2. **A missing reason is refused 400 before any Stripe call** (and before any audit row).
 * 3. **The audit row is written FIRST**: the Stripe mutation happens after the row exists, and a row
 *    that cannot be written means Stripe is never mutated.
 * 4. **A refund can never exceed what Stripe says is still refundable** (re-read server-side; the client's
 *    amount is only a request), a second refund sees the first, and the Stripe idempotency key is derived
 *    from invoice + amount + the client nonce.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const OVERALL = "11111111-1111-4111-8111-111111111111";
const MANAGER = "22222222-2222-4222-8222-222222222222";
const RESIDENT = "33333333-3333-4333-8333-333333333333";
const SUB = "sub_123";
const CUS = "cus_1";
const INV = "in_abc123def";
const NONCE = "nonce-12345678";

let tables: Record<string, Row[]> = {};
let auditInsertError: { message: string } | null = null;
const events: string[] = [];

function makeDb() {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const run = () => ({
        data: (tables[table] ?? []).filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v)),
        error: null,
      });
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (col: string, value: unknown) => {
          filters[col] = value;
          return q;
        },
        maybeSingle: async () => ({ data: (run().data as Row[])[0] ?? null, error: null }),
        insert: async (values: Row) => {
          if (table === "audit_log") {
            if (auditInsertError) return { error: auditInsertError };
            events.push("audit");
          }
          (tables[table] ??= []).push({ ...values });
          return { error: null };
        },
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve(run()).then(resolve, reject),
      };
      return q;
    },
  };
}

const getUser = vi.fn();
const isAdminUser = vi.fn();
const stripe = {
  subscriptions: { retrieve: vi.fn(), update: vi.fn(), cancel: vi.fn() },
  invoices: { retrieve: vi.fn() },
  paymentIntents: { retrieve: vi.fn() },
  charges: { retrieve: vi.fn() },
  refunds: { create: vi.fn() },
  prices: { retrieve: vi.fn() },
};
const assertTestWorkspace = vi.fn();
const reconcile = vi.fn();

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser } }) }));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: (...a: unknown[]) => isAdminUser(...a) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => makeDb() }));
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripe, isStripeLiveMode: () => false }));
vi.mock("@/lib/test-workspaces/effects.server", () => ({
  assertTestWorkspaceProviderEffectAllowed: (...a: unknown[]) => assertTestWorkspace(...a),
}));
vi.mock("@/lib/manager-stripe-subscription-sync", () => ({
  reconcileManagerPurchaseByStripeSubscriptionId: (...a: unknown[]) => reconcile(...a),
}));
vi.mock("@/lib/stripe/resolve-manager-price", () => ({ assertManagerPriceMatchesRateCard: vi.fn(async () => undefined) }));

const priceRoute = await import("@/app/api/admin/accounts/[id]/billing/price/route");
const refundRoute = await import("@/app/api/admin/accounts/[id]/billing/refund/route");
const cancelRoute = await import("@/app/api/admin/accounts/[id]/billing/cancel/route");

const call = (handler: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>, body: unknown, id = MANAGER) =>
  handler(
    new Request("https://proplane.ai/api/admin/accounts/x/billing/y", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );

const monthlyItem = (over: Record<string, unknown> = {}) => ({
  id: "si_1",
  current_period_end: Math.floor(Date.parse("2026-11-01T00:00:00Z") / 1000),
  price: {
    id: "price_pro_monthly",
    unit_amount: 4000,
    currency: "usd",
    product: "prod_pro",
    lookup_key: null,
    tax_behavior: "unspecified",
    recurring: { interval: "month", interval_count: 1 },
  },
  ...over,
});
const subscription = (over: Record<string, unknown> = {}) => ({
  id: SUB,
  status: "active",
  customer: CUS,
  cancel_at_period_end: false,
  metadata: {},
  items: { data: [monthlyItem()] },
  ...over,
});
const paidInvoice = (over: Record<string, unknown> = {}) => ({
  id: INV,
  customer: CUS,
  status: "paid",
  amount_paid: 4000,
  parent: { type: "subscription_details" },
  payments: { data: [{ status: "paid", payment: { type: "charge", charge: "ch_1" } }] },
  ...over,
});

const mutations = () =>
  stripe.subscriptions.update.mock.calls.length +
  stripe.subscriptions.cancel.mock.calls.length +
  stripe.refunds.create.mock.calls.length;

beforeEach(() => {
  vi.clearAllMocks();
  events.length = 0;
  auditInsertError = null;
  tables = {
    profile_roles: [{ user_id: MANAGER, role: "manager" }, { user_id: RESIDENT, role: "resident" }],
    manager_purchases: [
      {
        id: "p1",
        user_id: MANAGER,
        tier: "pro",
        billing: "monthly",
        paid_at: "2026-09-01T00:00:00.000Z",
        stripe_customer_id: CUS,
        stripe_subscription_id: SUB,
      },
    ],
  };
  getUser.mockResolvedValue({ data: { user: { id: OVERALL } } });
  isAdminUser.mockResolvedValue(true);
  assertTestWorkspace.mockResolvedValue(undefined);
  reconcile.mockResolvedValue(undefined);
  stripe.subscriptions.retrieve.mockResolvedValue(subscription());
  stripe.subscriptions.update.mockImplementation(async () => {
    events.push("stripe");
    return {};
  });
  stripe.subscriptions.cancel.mockImplementation(async () => {
    events.push("stripe");
    return {};
  });
  stripe.invoices.retrieve.mockResolvedValue(paidInvoice());
  stripe.charges.retrieve.mockResolvedValue({ id: "ch_1", amount: 4000, amount_refunded: 0, paid: true, disputed: false, currency: "usd" });
  stripe.refunds.create.mockImplementation(async () => {
    events.push("stripe");
    return { id: "re_1", status: "succeeded" };
  });
});

const routes = [
  ["price", priceRoute.POST, { monthlyCents: 2500, reason: "Pilot pricing" }],
  ["refund", refundRoute.POST, { invoiceId: INV, amountCents: 1000, nonce: NONCE, reason: "Billing error" }],
  ["cancel", cancelRoute.POST, { when: "now", reason: "Customer asked" }],
] as const;

describe.each(routes)("%s route gate", (_name, handler, body) => {
  it("signed out is 401 and nothing happens", async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    expect((await call(handler, body)).status).toBe(401);
    expect(mutations()).toBe(0);
    expect(tables.audit_log ?? []).toHaveLength(0);
  });

  it("a non-admin is 403 and nothing happens", async () => {
    isAdminUser.mockResolvedValue(false);
    expect((await call(handler, body)).status).toBe(403);
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
    expect(mutations()).toBe(0);
    expect(tables.audit_log ?? []).toHaveLength(0);
  });

  it("a workspace-only admin (a PropLane seat, no `admin` role) is 403", async () => {
    // A workspace admin signs in with a seat, never the `admin` row in profile_roles: isAdminUser is false for them.
    getUser.mockResolvedValue({ data: { user: { id: "seat-holder" } } });
    isAdminUser.mockImplementation(async (id: string) => id === OVERALL);
    expect((await call(handler, body)).status).toBe(403);
    expect(isAdminUser).toHaveBeenCalledWith("seat-holder");
    expect(mutations()).toBe(0);
  });

  it("a path id that is not a manager account is 404", async () => {
    expect((await call(handler, body, RESIDENT)).status).toBe(404);
    expect((await call(handler, body, "not-a-uuid")).status).toBe(404);
    expect(mutations()).toBe(0);
  });

  it("a missing reason is 400 and Stripe is never called", async () => {
    const { reason: _reason, ...withoutReason } = body as Record<string, unknown>;
    for (const b of [withoutReason, { ...withoutReason, reason: "   " }]) {
      const res = await call(handler, b);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/reason/i);
    }
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
    expect(stripe.invoices.retrieve).not.toHaveBeenCalled();
    expect(mutations()).toBe(0);
    expect(tables.audit_log ?? []).toHaveLength(0);
  });

  it("an account with no card subscription is refused 409", async () => {
    tables.manager_purchases = [{ id: "p1", user_id: MANAGER, tier: "free", billing: "free", paid_at: null, stripe_customer_id: null, stripe_subscription_id: null }];
    const res = await call(handler, body);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/no card subscription/i);
    expect(mutations()).toBe(0);
  });

  it("a failed audit insert means Stripe is never mutated", async () => {
    auditInsertError = { message: "audit down" };
    const res = await call(handler, body);
    expect(res.status).toBe(500);
    expect(mutations()).toBe(0);
  });
});

describe("price", () => {
  it("writes the audit row FIRST, then replaces the plan item from the next invoice with no proration", async () => {
    const res = await call(priceRoute.POST, { monthlyCents: 2500, reason: "Pilot pricing" });
    expect(res.status).toBe(200);
    expect(events).toEqual(["audit", "stripe"]);
    expect(stripe.subscriptions.update).toHaveBeenCalledWith(
      SUB,
      expect.objectContaining({
        proration_behavior: "none",
        items: [
          {
            id: "si_1",
            price_data: { currency: "usd", product: "prod_pro", recurring: { interval: "month", interval_count: 1 }, unit_amount: 2500 },
          },
        ],
      }),
    );
    const audit = tables.audit_log![0]!;
    expect(audit.actor_user_id).toBe(OVERALL);
    expect(audit.landlord_id).toBe(MANAGER);
    expect(audit.input_summary).toMatchObject({ field: "monthlyPriceCents", before: 4000, after: 2500, reason: "Pilot pricing" });
  });

  it("refuses a zero, negative, fractional or absurd amount before reading Stripe", async () => {
    for (const monthlyCents of [0, -5, 12.5, "25", 100_000_000]) {
      expect((await call(priceRoute.POST, { monthlyCents, reason: "x" })).status).toBe(400);
    }
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it("refuses an annual subscription", async () => {
    stripe.subscriptions.retrieve.mockResolvedValue(
      subscription({ items: { data: [monthlyItem({ price: { ...monthlyItem().price, recurring: { interval: "year", interval_count: 1 } } })] } }),
    );
    expect((await call(priceRoute.POST, { monthlyCents: 2500, reason: "x" })).status).toBe(409);
    expect(mutations()).toBe(0);
  });

  it("marks a Stripe failure after the audit row so the trail never claims it applied", async () => {
    stripe.subscriptions.update.mockRejectedValue(new Error("boom"));
    const res = await call(priceRoute.POST, { monthlyCents: 2500, reason: "Pilot pricing" });
    expect(res.status).toBe(502);
    expect(tables.audit_log!.map((r) => (r.input_summary as { field: string }).field)).toEqual(["monthlyPriceCents", "monthlyPriceCentsFailed"]);
  });
});

describe("refund", () => {
  it("refunds part of a paid invoice with an idempotency key from invoice + amount + nonce, audit first", async () => {
    const res = await call(refundRoute.POST, { invoiceId: INV, amountCents: 1500, nonce: NONCE, reason: "Billing error" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, refundId: "re_1", amountCents: 1500, remainingRefundableCents: 2500 });
    expect(events).toEqual(["audit", "stripe"]);
    expect(stripe.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({ charge: "ch_1", amount: 1500 }),
      { idempotencyKey: `admin-refund:${INV}:1500:${NONCE}` },
    );
  });

  it("refuses more than is still refundable, re-read from Stripe, and calls no refund", async () => {
    stripe.charges.retrieve.mockResolvedValue({ id: "ch_1", amount: 4000, amount_refunded: 3000, paid: true, disputed: false, currency: "usd" });
    const res = await call(refundRoute.POST, { invoiceId: INV, amountCents: 1500, nonce: NONCE, reason: "Billing error" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/\$10\.00 is still refundable/);
    expect(stripe.refunds.create).not.toHaveBeenCalled();
    expect(tables.audit_log ?? []).toHaveLength(0);
  });

  it("refusing the same refund twice cannot exceed the invoice", async () => {
    let refunded = 0;
    stripe.charges.retrieve.mockImplementation(async () => ({ id: "ch_1", amount: 4000, amount_refunded: refunded, paid: true, disputed: false, currency: "usd" }));
    stripe.refunds.create.mockImplementation(async (p: { amount: number }) => {
      refunded += p.amount;
      return { id: `re_${refunded}`, status: "succeeded" };
    });
    const body = (nonce: string) => ({ invoiceId: INV, amountCents: 4000, nonce, reason: "Billing error" });
    expect((await call(refundRoute.POST, body("nonce-aaaaaaaa"))).status).toBe(200);
    const second = await call(refundRoute.POST, body("nonce-bbbbbbbb"));
    expect(second.status).toBe(409);
    expect((await second.json()).error).toMatch(/fully refunded/i);
    expect(stripe.refunds.create).toHaveBeenCalledTimes(1);
  });

  it("refuses a zero, negative, fractional or non-number amount and a missing nonce before Stripe", async () => {
    for (const amountCents of [0, -100, 10.5, "1000", null]) {
      expect((await call(refundRoute.POST, { invoiceId: INV, amountCents, nonce: NONCE, reason: "x" })).status).toBe(400);
    }
    expect((await call(refundRoute.POST, { invoiceId: INV, amountCents: 100, reason: "x" })).status).toBe(400);
    expect((await call(refundRoute.POST, { invoiceId: "nope", amountCents: 100, nonce: NONCE, reason: "x" })).status).toBe(400);
    expect(stripe.invoices.retrieve).not.toHaveBeenCalled();
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });

  it("refuses another customer's invoice, an unpaid one and a non-subscription one", async () => {
    const body = { invoiceId: INV, amountCents: 100, nonce: NONCE, reason: "x" };
    stripe.invoices.retrieve.mockResolvedValue(paidInvoice({ customer: "cus_other" }));
    expect((await call(refundRoute.POST, body)).status).toBe(404);
    stripe.invoices.retrieve.mockResolvedValue(paidInvoice({ status: "open" }));
    expect((await call(refundRoute.POST, body)).status).toBe(409);
    stripe.invoices.retrieve.mockResolvedValue(paidInvoice({ parent: { type: "quote_details" } }));
    expect((await call(refundRoute.POST, body)).status).toBe(409);
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });

  it("a Stripe failure after the audit row leaves a Failed row", async () => {
    stripe.refunds.create.mockRejectedValue(new Error("boom"));
    const res = await call(refundRoute.POST, { invoiceId: INV, amountCents: 100, nonce: NONCE, reason: "x" });
    expect(res.status).toBe(502);
    expect(tables.audit_log!.map((r) => (r.input_summary as { field: string }).field)).toEqual([`refund:${INV}`, `refund:${INV}Failed`]);
  });
});

describe("cancel", () => {
  it("cancels at period end after the audit row", async () => {
    const res = await call(cancelRoute.POST, { when: "period_end", reason: "Customer asked" });
    expect(res.status).toBe(200);
    expect(events).toEqual(["audit", "stripe"]);
    expect(stripe.subscriptions.update).toHaveBeenCalledWith(SUB, { cancel_at_period_end: true });
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledWith(SUB);
  });

  it("cancels now with no proration and no final invoice", async () => {
    expect((await call(cancelRoute.POST, { when: "now", reason: "Customer asked" })).status).toBe(200);
    expect(stripe.subscriptions.cancel).toHaveBeenCalledWith(SUB, { prorate: false, invoice_now: false });
  });

  it("refuses an unknown `when`, an already canceled subscription and a repeat period-end cancel", async () => {
    expect((await call(cancelRoute.POST, { when: "tomorrow", reason: "x" })).status).toBe(400);
    stripe.subscriptions.retrieve.mockResolvedValue(subscription({ status: "canceled" }));
    expect((await call(cancelRoute.POST, { when: "now", reason: "x" })).status).toBe(409);
    stripe.subscriptions.retrieve.mockResolvedValue(subscription({ cancel_at_period_end: true }));
    expect((await call(cancelRoute.POST, { when: "period_end", reason: "x" })).status).toBe(409);
    expect(mutations()).toBe(0);
  });
});
