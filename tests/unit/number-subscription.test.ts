/**
 * PropLane Number is money: $5/month for a vendor or resident plus a prepaid message-credit ledger.
 * These tests drive the real routes, helpers and the signed webhook against in-memory fakes; the SQL
 * contract (monthly included credit spent first, purchased credit never expiring, replay and ordering
 * safety, owner isolation) is covered by tests/integration/number-credit-postgres.test.ts.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLinkedFormFakeDb, type LinkedFormFakeDb } from "../helpers/linked-form-fake-db";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;

type Ctx = {
  user: { id: string; email: string } | null;
  profile: { email: string; full_name: string } | null;
  roles: string[];
  effectiveRole: string | null;
};

const state = vi.hoisted(() => ({
  db: null as unknown,
  stripe: null as unknown,
  ctx: null as unknown,
  session: null as unknown,
  rateLimit: { ok: true } as { ok: boolean; unavailable?: true },
  rpc: vi.fn(),
  event: null as unknown,
}));

vi.mock("next/headers", () => ({ headers: async () => ({ get: () => "sig" }) }));
vi.mock("@/lib/stripe", () => ({ getStripe: () => state.stripe }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => state.db }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: async () => state.rateLimit }));
vi.mock("@/lib/auth/portal-access", () => ({
  getPortalAccessContext: async () => state.ctx,
  hasRole: (ctx: Ctx, role: string) => ctx.roles.includes(role),
}));
vi.mock("@/lib/auth/server-profile", () => ({ getServerSessionProfile: async () => state.session }));
vi.mock("@/lib/test-workspaces/effects.server", () => ({
  assertTestWorkspaceProviderEffectAllowed: async () => undefined,
  captureTestWorkspaceEffectForUser: async () => ({ captured: false }),
}));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
// Vendor auto-provisioning after activation is tested on its own (vendor-number-subscription-gating.test.ts);
// here only the webhook wiring is asserted.
const activation = vi.hoisted(() => ({ provision: vi.fn(async () => "provisioned") }));
vi.mock("@/lib/number-subscription/vendor-number-activation.server", () => ({ provisionVendorNumberOnActivation: activation.provision }));

// A resident's number is provisioned by the webhook only for a subscription recorded as a resident's.
const residentNumber = vi.hoisted(() => ({ provision: vi.fn(async () => ({ status: "ready", phoneNumber: "+12065550177" })) }));
vi.mock("@/lib/resident-agent-number/number.server", () => ({ provisionResidentAgentNumber: residentNumber.provision }));

import { POST as checkoutRoute } from "@/app/api/number-subscription/checkout/route";
import { POST as creditCheckoutRoute } from "@/app/api/number-subscription/credit-checkout/route";
import { POST as portalRoute } from "@/app/api/number-subscription/portal/route";
import { GET as statusRoute } from "@/app/api/number-subscription/route";
import { POST as webhook } from "@/app/api/stripe/webhook/route";
import {
  NUMBER_CREDIT_PURPOSE,
  NUMBER_SUBSCRIPTION_LOOKUP_KEY,
  NUMBER_SUBSCRIPTION_PURPOSE,
  safeNumberReturnPath,
} from "@/lib/number-subscription/constants";
import {
  createNumberCreditCheckout,
  fulfillNumberCreditPurchase,
  getNumberCreditBalance,
  NumberCreditValidationError,
  reserveNumberCredit,
  reverseNumberCreditForPaymentIntent,
} from "@/lib/number-subscription/credit.server";
import { resetNumberPriceCacheForTests } from "@/lib/number-subscription/stripe.server";
import { numberServiceEntitled, numberSubscriptionActive } from "@/lib/number-subscription/subscription.server";

const VENDOR = "11111111-1111-4111-8111-111111111111";
const RESIDENT = "22222222-2222-4222-8222-222222222222";
const MANAGER = "33333333-3333-4333-8333-333333333333";
const PRICE = "price_number";

function actAs(id: string | null, roles: string[], effectiveRole: string | null = roles.length === 1 ? roles[0]! : null) {
  state.ctx = id
    ? ({ user: { id, email: "o@example.com" }, profile: { email: "o@example.com", full_name: "O" }, roles, effectiveRole } satisfies Ctx)
    : ({ user: null, profile: null, roles: [], effectiveRole: null } satisfies Ctx);
  state.session = { user: id ? { id } : null, viewAs: null };
}

function makeDb(seed: Record<string, Array<Record<string, unknown>>> = {}): LinkedFormFakeDb {
  const db = createLinkedFormFakeDb({
    profiles: [
      { id: VENDOR, stripe_customer_id: "cus_vendor", full_name: "Vee" },
      { id: RESIDENT, stripe_customer_id: null, full_name: "Rez" },
      { id: MANAGER, stripe_customer_id: "cus_manager", full_name: "Max" },
    ],
    ...seed,
  });
  (db as unknown as { rpc: unknown }).rpc = (name: string, args: unknown) => state.rpc(name, args);
  // Faithful to the real tables for the two inserts the code relies on: column defaults and uniqueness (23505).
  const baseFrom = db.from.bind(db) as (name: string) => Loose;
  (db as unknown as { from: unknown }).from = (name: string) => {
    const builder = baseFrom(name);
    const unique = name === "number_credit_purchases" ? "id" : name === "number_subscriptions" ? "owner_user_id" : null;
    if (unique) {
      const insert = builder.insert as (row: Record<string, unknown>) => unknown;
      builder.insert = (row: Record<string, unknown>) => {
        if (db.tables[name]?.some((r) => r[unique] === row[unique])) {
          return Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key" } });
        }
        const defaults = name === "number_credit_purchases" ? { status: "pending", stripe_session_id: null } : { status: "incomplete" };
        return insert({ ...defaults, ...row });
      };
    }
    return builder;
  };
  return db;
}

function makeStripe(over: Record<string, unknown> = {}) {
  return {
    customers: { create: vi.fn(async () => ({ id: "cus_new" })) },
    prices: {
      list: vi.fn(async () => ({
        data: [{ id: PRICE, unit_amount: 500, currency: "usd", type: "recurring", recurring: { interval: "month", interval_count: 1 } }],
      })),
      create: vi.fn(),
    },
    products: { create: vi.fn() },
    subscriptions: { list: vi.fn(async () => ({ data: [] })), retrieve: vi.fn() },
    checkout: {
      sessions: {
        create: vi.fn(async () => ({ id: "cs_new", url: "https://checkout.stripe.test/s" })),
        retrieve: vi.fn(),
      },
    },
    billingPortal: { sessions: { create: vi.fn(async () => ({ url: "https://billing.stripe.test/p" })) } },
    webhooks: { constructEvent: () => state.event },
    charges: { retrieve: vi.fn() },
    ...over,
  };
}

const json = (body: unknown) => ({ method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const req = (path: string, body: unknown = {}) => new Request(`http://localhost${path}`, json(body));

const subRow = (over: Record<string, unknown> = {}) => ({
  owner_user_id: VENDOR,
  owner_role: "vendor",
  status: "active",
  current_period_end: "2026-11-08T00:00:00Z",
  cancel_at_period_end: false,
  stripe_customer_id: "cus_vendor",
  stripe_subscription_id: "sub_1",
  ...over,
});

function liveSub(over: Record<string, unknown> = {}) {
  return {
    id: "sub_1",
    customer: "cus_vendor",
    status: "active",
    cancel_at_period_end: false,
    metadata: { purpose: NUMBER_SUBSCRIPTION_PURPOSE, owner_user_id: VENDOR, owner_role: "vendor" },
    items: {
      data: [{ quantity: 1, current_period_end: 1_800_000_000, price: { id: PRICE, lookup_key: NUMBER_SUBSCRIPTION_LOOKUP_KEY, unit_amount: 500 } }],
    },
    ...over,
  };
}

beforeEach(() => {
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_test");
  vi.stubEnv("NUMBER_SUBSCRIPTION_ENABLED", "1");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  resetNumberPriceCacheForTests();
  state.rateLimit = { ok: true };
  state.rpc = vi.fn(async () => ({ data: "applied", error: null }));
  state.stripe = makeStripe();
  state.db = makeDb();
  actAs(VENDOR, ["vendor"]);
});

describe("POST /api/number-subscription/checkout", () => {
  it("is off by default", async () => {
    vi.stubEnv("NUMBER_SUBSCRIPTION_ENABLED", "");
    const res = await checkoutRoute(req("/api/number-subscription/checkout"));
    expect(res.status).toBe(404);
    expect((state.stripe as ReturnType<typeof makeStripe>).checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("refuses anonymous callers and accounts that are neither vendor nor resident", async () => {
    actAs(null, []);
    expect((await checkoutRoute(req("/api/number-subscription/checkout"))).status).toBe(401);
    actAs(MANAGER, ["manager"]);
    expect((await checkoutRoute(req("/api/number-subscription/checkout"))).status).toBe(403);
    actAs(MANAGER, ["manager", "admin"]);
    expect((await checkoutRoute(req("/api/number-subscription/checkout", { role: "vendor" }))).status).toBe(403);
    expect((state.stripe as ReturnType<typeof makeStripe>).checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("refuses a View-as session so an operator never starts a charge as the viewed account", async () => {
    (state.session as { viewAs: unknown }).viewAs = { target: { roles: ["vendor"] } };
    expect((await checkoutRoute(req("/api/number-subscription/checkout"))).status).toBe(403);
  });

  it("lets a vendor subscribe: owner id, role, customer and price are all server-derived", async () => {
    const res = await checkoutRoute(
      req("/api/number-subscription/checkout", { owner_user_id: MANAGER, customer: "cus_manager", priceId: "price_evil", returnPath: "https://evil.example/x" }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).url).toBe("https://checkout.stripe.test/s");
    const stripe = state.stripe as ReturnType<typeof makeStripe>;
    const [params] = stripe.checkout.sessions.create.mock.calls[0] as unknown as [Loose];
    expect(params).toMatchObject({
      mode: "subscription",
      customer: "cus_vendor",
      client_reference_id: VENDOR,
      line_items: [{ price: PRICE, quantity: 1 }],
      metadata: { purpose: NUMBER_SUBSCRIPTION_PURPOSE, owner_user_id: VENDOR, owner_role: "vendor" },
      subscription_data: { metadata: { purpose: NUMBER_SUBSCRIPTION_PURPOSE, owner_user_id: VENDOR, owner_role: "vendor" } },
      allow_promotion_codes: false,
    });
    expect(params.success_url).toBe("http://localhost/vendor?number=success");
    const rows = (state.db as LinkedFormFakeDb).tables.number_subscriptions!;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ owner_user_id: VENDOR, owner_role: "vendor", stripe_customer_id: "cus_vendor", status: "incomplete" });
  });

  it("lets a resident subscribe and creates their Stripe customer on the shared profile column", async () => {
    actAs(RESIDENT, ["resident"]);
    const res = await checkoutRoute(req("/api/number-subscription/checkout"));
    expect(res.status).toBe(200);
    const stripe = state.stripe as ReturnType<typeof makeStripe>;
    expect(stripe.customers.create).toHaveBeenCalledTimes(1);
    expect((state.db as LinkedFormFakeDb).tables.profiles!.find((p) => p.id === RESIDENT)!.stripe_customer_id).toBe("cus_new");
    const [params] = stripe.checkout.sessions.create.mock.calls[0] as unknown as [Loose];
    expect(params.metadata.owner_role).toBe("resident");
    expect(params.success_url).toBe("http://localhost/resident?number=success");
  });

  it("a multi-role account must say which role it is acting as, and may only name one it holds", async () => {
    actAs(VENDOR, ["vendor", "resident"], null);
    expect((await checkoutRoute(req("/api/number-subscription/checkout"))).status).toBe(400);
    actAs(VENDOR, ["vendor", "manager"]);
    expect((await checkoutRoute(req("/api/number-subscription/checkout", { role: "resident" }))).status).toBe(403);
  });

  it("refuses when already subscribed (active or in grace) without opening a session", async () => {
    for (const status of ["active", "past_due"]) {
      state.db = makeDb({ number_subscriptions: [subRow({ status })] });
      const res = await checkoutRoute(req("/api/number-subscription/checkout"));
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe("already_subscribed");
    }
    expect((state.stripe as ReturnType<typeof makeStripe>).checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("refuses when Stripe already has a live subscription the webhook has not delivered yet", async () => {
    const stripe = state.stripe as ReturnType<typeof makeStripe>;
    stripe.subscriptions.list.mockResolvedValueOnce({ data: [{ status: "active" }] } as never);
    expect((await checkoutRoute(req("/api/number-subscription/checkout"))).status).toBe(409);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("a canceled subscriber can subscribe again", async () => {
    state.db = makeDb({ number_subscriptions: [subRow({ status: "canceled" })] });
    expect((await checkoutRoute(req("/api/number-subscription/checkout"))).status).toBe(200);
  });

  it("sells only the exact $5.00 monthly price", async () => {
    const stripe = state.stripe as ReturnType<typeof makeStripe>;
    stripe.prices.list.mockResolvedValue({ data: [{ id: "price_bad", unit_amount: 100, currency: "usd", type: "recurring", recurring: { interval: "month" } }] } as never);
    expect((await checkoutRoute(req("/api/number-subscription/checkout"))).status).toBe(503);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("creates the product and price lazily, once", async () => {
    const stripe = state.stripe as ReturnType<typeof makeStripe>;
    stripe.prices.list.mockResolvedValue({ data: [] } as never);
    stripe.products.create.mockResolvedValue({ id: NUMBER_SUBSCRIPTION_LOOKUP_KEY } as never);
    stripe.prices.create.mockResolvedValue({ id: PRICE } as never);
    expect((await checkoutRoute(req("/api/number-subscription/checkout"))).status).toBe(200);
    expect(stripe.prices.create).toHaveBeenCalledWith(
      expect.objectContaining({ currency: "usd", unit_amount: 500, recurring: { interval: "month" }, lookup_key: NUMBER_SUBSCRIPTION_LOOKUP_KEY }),
    );
    state.db = makeDb();
    expect((await checkoutRoute(req("/api/number-subscription/checkout"))).status).toBe(200);
    expect(stripe.prices.create).toHaveBeenCalledTimes(1);
  });
});

describe("billing portal and status", () => {
  it("opens the portal for the caller's own customer only, from our row", async () => {
    state.db = makeDb({
      number_subscriptions: [subRow(), subRow({ owner_user_id: RESIDENT, owner_role: "resident", stripe_customer_id: "cus_other", stripe_subscription_id: "sub_2" })],
    });
    const res = await portalRoute(req("/api/number-subscription/portal", { customer: "cus_other" }));
    expect(res.status).toBe(200);
    const stripe = state.stripe as ReturnType<typeof makeStripe>;
    expect(stripe.billingPortal.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ customer: "cus_vendor" }));
  });

  it("has no portal for someone who never subscribed, a manager or an anonymous caller", async () => {
    expect((await portalRoute(req("/api/number-subscription/portal"))).status).toBe(404);
    actAs(MANAGER, ["manager"]);
    expect((await portalRoute(req("/api/number-subscription/portal"))).status).toBe(403);
    actAs(null, []);
    expect((await portalRoute(req("/api/number-subscription/portal"))).status).toBe(401);
  });

  it("GET returns the caller's own status and balance and never a Stripe id", async () => {
    state.db = makeDb({ number_subscriptions: [subRow(), subRow({ owner_user_id: RESIDENT, status: "canceled", stripe_subscription_id: "sub_2" })] });
    state.rpc = vi.fn(async () => ({
      data: { included_remaining_cents: 210, purchased_cents: 500, next_reset: "2026-11-01", subscription_status: "active" },
      error: null,
    }));
    const res = await statusRoute(new Request("http://localhost/api/number-subscription"));
    const body = await res.json();
    expect(body.subscription).toEqual({ status: "active", role: "vendor", currentPeriodEnd: "2026-11-08T00:00:00Z", cancelAtPeriodEnd: false });
    expect(body.credit).toMatchObject({ includedCents: 210, purchasedCents: 500, totalCents: 710, resetsAt: "2026-11-01" });
    expect(JSON.stringify(body)).not.toMatch(/cus_|sub_/);
    expect(state.rpc).toHaveBeenCalledWith("number_credit_snapshot", { p_owner: VENDOR, p_included_cents: 300, p_apply: false });
  });

  it("numberSubscriptionActive is exactly active; numberServiceEntitled also covers the past_due grace", async () => {
    for (const [status, active, entitled] of [
      ["active", true, true],
      ["past_due", false, true],
      ["canceled", false, false],
      ["incomplete", false, false],
    ] as const) {
      const db = makeDb({ number_subscriptions: [subRow({ status })] }) as never;
      expect(await numberSubscriptionActive(VENDOR, db)).toBe(active);
      expect(await numberServiceEntitled(VENDOR, db)).toBe(entitled);
    }
    expect(await numberSubscriptionActive(RESIDENT, makeDb() as never)).toBe(false);
  });
});

function deliver(type: string, object: Record<string, unknown>, id = "evt_1") {
  state.event = { id, type, data: { object } };
  return webhook(new Request("http://localhost/api/stripe/webhook", { method: "POST", body: "{}" }));
}
const applyCalls = () => state.rpc.mock.calls.filter(([name]) => name === "apply_number_subscription_event").map(([, args]) => args);

function paidSession(over: Record<string, unknown> = {}) {
  return {
    id: "cs_sub",
    mode: "subscription",
    payment_status: "paid",
    currency: "usd",
    amount_subtotal: 500,
    customer: "cus_vendor",
    subscription: "sub_1",
    client_reference_id: VENDOR,
    metadata: { purpose: NUMBER_SUBSCRIPTION_PURPOSE, owner_user_id: VENDOR, owner_role: "vendor" },
    ...over,
  };
}

describe("Stripe webhook: PropLane Number subscription", () => {
  beforeEach(() => {
    state.db = makeDb({ number_subscriptions: [subRow({ status: "incomplete", stripe_subscription_id: null })] });
    (state.stripe as ReturnType<typeof makeStripe>).subscriptions.retrieve.mockResolvedValue(liveSub() as never);
  });

  it("fulfils a paid subscription checkout from the row our route wrote and the subscription as Stripe reports it", async () => {
    expect((await deliver("checkout.session.completed", paidSession())).status).toBe(200);
    expect(applyCalls()).toEqual([
      expect.objectContaining({ p_owner: VENDOR, p_role: "vendor", p_customer: "cus_vendor", p_subscription: "sub_1", p_status: "active", p_cancel_at_period_end: false }),
    ]);
    expect((applyCalls()[0] as { p_period_end: string }).p_period_end).toBe(new Date(1_800_000_000 * 1000).toISOString());
  });

  it("provisions the vendor's number only after the subscription was APPLIED, from the subscription id", async () => {
    activation.provision.mockClear();
    await deliver("checkout.session.completed", paidSession());
    expect(activation.provision).toHaveBeenCalledTimes(1);
    expect(activation.provision).toHaveBeenCalledWith(state.db, "sub_1");
    // Rejected, unpaid and stale writes provision nothing.
    activation.provision.mockClear();
    await deliver("checkout.session.completed", paidSession({ payment_status: "unpaid" }));
    await deliver("checkout.session.completed", paidSession({ amount_subtotal: 100 }));
    state.rpc = vi.fn(async () => ({ data: "stale", error: null }));
    await deliver("checkout.session.completed", paidSession());
    expect(activation.provision).not.toHaveBeenCalled();
  });

  it("a subscription.updated that applied also offers provisioning (idempotent), one that did not does not", async () => {
    state.db = makeDb({ number_subscriptions: [subRow()] });
    activation.provision.mockClear();
    await deliver("customer.subscription.updated", liveSub());
    expect(activation.provision).toHaveBeenCalledWith(state.db, "sub_1");
    activation.provision.mockClear();
    state.rpc = vi.fn(async () => ({ data: "customer_mismatch", error: null }));
    await deliver("customer.subscription.updated", liveSub());
    expect(activation.provision).not.toHaveBeenCalled();
  });

  it("routes each role once: a resident row provisions the resident number (one call per event), a vendor row never does", async () => {
    const residentLive = liveSub({
      id: "sub_r", customer: "cus_res", metadata: { purpose: NUMBER_SUBSCRIPTION_PURPOSE, owner_user_id: RESIDENT, owner_role: "resident" },
    });
    state.db = makeDb({ number_subscriptions: [subRow({ owner_user_id: RESIDENT, owner_role: "resident", stripe_customer_id: "cus_res", stripe_subscription_id: "sub_r" })] });
    (state.stripe as ReturnType<typeof makeStripe>).subscriptions.retrieve.mockResolvedValue(residentLive as never);
    residentNumber.provision.mockClear();
    activation.provision.mockClear();
    await deliver("customer.subscription.updated", residentLive);
    expect(residentNumber.provision).toHaveBeenCalledTimes(1);
    expect(residentNumber.provision).toHaveBeenCalledWith(state.db, RESIDENT, { requireFlag: false });
    expect(applyCalls()).toEqual([expect.objectContaining({ p_owner: RESIDENT, p_role: "resident" })]);
    // The vendor hook is offered the same event but only ever acts on a vendor row (see vendor-number-subscription-gating).
    expect(activation.provision).toHaveBeenCalledTimes(1);

    // A vendor row: the resident provisioner is never reached.
    state.db = makeDb({ number_subscriptions: [subRow()] });
    (state.stripe as ReturnType<typeof makeStripe>).subscriptions.retrieve.mockResolvedValue(liveSub() as never);
    residentNumber.provision.mockClear();
    await deliver("customer.subscription.updated", liveSub());
    expect(residentNumber.provision).not.toHaveBeenCalled();
  });

  it("one subscription per login: a user holding both roles is provisioned for the role recorded at first checkout only", async () => {
    // VENDOR also holds the resident role, but its single row says vendor: the webhook provisions the vendor number
    // and never a resident one (the resident number is then offered from Settings under the same subscription).
    actAs(VENDOR, ["vendor", "resident"], null);
    state.db = makeDb({ number_subscriptions: [subRow()] });
    (state.stripe as ReturnType<typeof makeStripe>).subscriptions.retrieve.mockResolvedValue(liveSub() as never);
    residentNumber.provision.mockClear();
    activation.provision.mockClear();
    await deliver("customer.subscription.updated", liveSub());
    expect(activation.provision).toHaveBeenCalledTimes(1);
    expect(residentNumber.provision).not.toHaveBeenCalled();
    // A second checkout cannot create a second subscription while the first is live.
    const res = await checkoutRoute(req("/api/number-subscription/checkout", { role: "resident" }));
    expect(res.status).toBe(409);
  });

  it("a replayed event records the same state again (the database function makes that a no-op), never a second grant", async () => {
    await deliver("checkout.session.completed", paidSession(), "evt_a");
    await deliver("checkout.session.completed", paidSession(), "evt_a");
    const [first, second] = applyCalls() as Array<Record<string, unknown>>;
    expect({ ...second, p_event_at: 0 }).toEqual({ ...first, p_event_at: 0 });
    // No credit RPC is ever called by a subscription event: replay cannot mint credit.
    expect(state.rpc.mock.calls.some(([name]) => /credit/.test(String(name)))).toBe(false);
  });

  it("an unpaid (async) session grants nothing", async () => {
    await deliver("checkout.session.completed", paidSession({ payment_status: "unpaid" }));
    expect(applyCalls()).toHaveLength(0);
  });

  it.each([
    ["metadata owner differs from the checkout reference", { client_reference_id: MANAGER }],
    ["customer is not the one on our record", { customer: "cus_attacker" }],
    ["amount is not $5.00", { amount_subtotal: 100 }],
    ["currency is not USD", { currency: "eur" }],
    ["owner has no checkout record", { metadata: { purpose: NUMBER_SUBSCRIPTION_PURPOSE, owner_user_id: RESIDENT }, client_reference_id: RESIDENT }],
  ])("grants nothing when the %s", async (_name, over) => {
    expect((await deliver("checkout.session.completed", paidSession(over))).status).toBe(200);
    expect(applyCalls()).toHaveLength(0);
  });

  it.each([
    ["subscription belongs to another owner", { metadata: { purpose: NUMBER_SUBSCRIPTION_PURPOSE, owner_user_id: MANAGER } }],
    ["subscription is another customer's", { customer: "cus_attacker" }],
    ["subscription is not the $5 number price", { items: { data: [{ quantity: 1, price: { id: "p", lookup_key: "other", unit_amount: 500 } }] } }],
    ["subscription has a different quantity", { items: { data: [{ quantity: 5, price: { id: PRICE, lookup_key: NUMBER_SUBSCRIPTION_LOOKUP_KEY, unit_amount: 500 } }] } }],
  ])("grants nothing when the %s", async (_name, over) => {
    (state.stripe as ReturnType<typeof makeStripe>).subscriptions.retrieve.mockResolvedValue(liveSub(over) as never);
    await deliver("checkout.session.completed", paidSession());
    expect(applyCalls()).toHaveLength(0);
  });

  it("subscription events for a number subscription never reach the manager plan handlers", async () => {
    state.db = makeDb({ number_subscriptions: [subRow()] });
    for (const type of ["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"]) {
      const res = await deliver(type, liveSub({ status: "past_due" }));
      expect(res.status).toBe(200);
    }
    expect(applyCalls()).toHaveLength(3);
  });

  it("a subscription that is not a number subscription still takes the manager path", async () => {
    const res = await deliver("customer.subscription.updated", { id: "sub_manager", customer: "cus_m", status: "active", metadata: {} });
    expect(res.status).toBe(500); // manager handler: "Could not resolve subscription ownership" (unchanged behaviour)
    expect(applyCalls()).toHaveLength(0);
  });

  it("out-of-order delivery cannot resurrect a canceled subscription: the state written is Stripe's current state, not the event payload", async () => {
    state.db = makeDb({ number_subscriptions: [subRow()] });
    const stripe = state.stripe as ReturnType<typeof makeStripe>;
    stripe.subscriptions.retrieve.mockResolvedValue(liveSub({ status: "canceled" }) as never);
    // The canceled event arrives first, then an old "active" update that was created before it.
    await deliver("customer.subscription.deleted", liveSub({ status: "canceled" }), "evt_2");
    await deliver("customer.subscription.updated", liveSub({ status: "active" }), "evt_1");
    expect((applyCalls() as Array<{ p_status: string }>).map((c) => c.p_status)).toEqual(["canceled", "canceled"]);
  });

  it("the first subscription event can arrive before checkout.session.completed: ownership resolves through our row and customer", async () => {
    const created = liveSub({ status: "incomplete" });
    (state.stripe as ReturnType<typeof makeStripe>).subscriptions.retrieve.mockResolvedValue(created as never);
    expect((await deliver("customer.subscription.created", created)).status).toBe(200);
    expect(applyCalls()).toEqual([expect.objectContaining({ p_owner: VENDOR, p_status: "incomplete" })]);
  });

  it("a forged first event (owner in metadata, customer not on our record) is ignored", async () => {
    const forged = liveSub({ customer: "cus_attacker" });
    (state.stripe as ReturnType<typeof makeStripe>).subscriptions.retrieve.mockResolvedValue(forged as never);
    expect((await deliver("customer.subscription.created", forged)).status).toBe(200);
    expect(applyCalls()).toHaveLength(0);
  });

  it("invoice.payment_failed re-reads the subscription so Stripe decides past_due; invoice.paid does not hit the manager path", async () => {
    state.db = makeDb({ number_subscriptions: [subRow()] });
    (state.stripe as ReturnType<typeof makeStripe>).subscriptions.retrieve.mockResolvedValue(liveSub({ status: "past_due" }) as never);
    const invoice = { id: "in_1", subscription: "sub_1", billing_reason: "subscription_cycle", amount_paid: 500 };
    expect((await deliver("invoice.payment_failed", invoice)).status).toBe(200);
    expect(applyCalls()).toEqual([expect.objectContaining({ p_status: "past_due" })]);
    expect((await deliver("invoice.paid", invoice)).status).toBe(200);
  });

  it("maps Stripe statuses without granting on anything unfamiliar", async () => {
    state.db = makeDb({ number_subscriptions: [subRow()] });
    const stripe = state.stripe as ReturnType<typeof makeStripe>;
    for (const [stripeStatus, ours] of [
      ["trialing", "active"],
      ["unpaid", "past_due"],
      ["incomplete_expired", "canceled"],
      ["paused", "canceled"],
      ["something_new", "canceled"],
    ]) {
      state.rpc.mockClear();
      stripe.subscriptions.retrieve.mockResolvedValue(liveSub({ status: stripeStatus }) as never);
      await deliver("customer.subscription.updated", liveSub({ status: stripeStatus }));
      expect((applyCalls()[0] as { p_status: string }).p_status).toBe(ours);
    }
  });

  it("answers 500 (so Stripe redelivers) when the state cannot be recorded", async () => {
    state.db = makeDb({ number_subscriptions: [subRow()] });
    state.rpc = vi.fn(async () => ({ data: null, error: { message: "boom" } }));
    expect((await deliver("customer.subscription.updated", liveSub())).status).toBe(500);
  });
});

const PURCHASE = "44444444-4444-4444-8444-444444444444";
function creditSession(over: Record<string, unknown> = {}) {
  return {
    id: "cs_credit",
    mode: "payment",
    payment_status: "paid",
    currency: "usd",
    amount_subtotal: 2000,
    amount_total: 2000,
    payment_intent: "pi_1",
    client_reference_id: VENDOR,
    total_details: { amount_discount: 0 },
    metadata: { purpose: NUMBER_CREDIT_PURPOSE, owner_user_id: VENDOR, purchase_id: PURCHASE, credit_cents: "2000" },
    ...over,
  };
}
const fulfillCalls = () => state.rpc.mock.calls.filter(([name]) => name === "fulfill_number_credit_purchase");

describe("number credit: reserve before work, buy credit", () => {
  it("reserves at the manager meter rates, with the $3 monthly grant, and maps the answer", async () => {
    state.rpc = vi.fn(async () => ({ data: { allowed: true, duplicate: false, state: "reserved" }, error: null }));
    const reservation = await reserveNumberCredit(VENDOR, "sms_outbound_segment", 2, "key-1", { db: makeDb() as never });
    expect(reservation).toEqual({ allowed: true, duplicate: false, state: "reserved" });
    expect(state.rpc).toHaveBeenCalledWith(
      "reserve_number_credit",
      expect.objectContaining({ p_owner: VENDOR, p_key: "key-1", p_meter: "sms_outbound_segment", p_quantity: 2, p_unit_cents: 3, p_included_cents: 300, p_allow_unfunded: false }),
    );
    await reserveNumberCredit(VENDOR, "ai_agent_turn", 1, "key-2", { db: makeDb() as never });
    expect(state.rpc).toHaveBeenLastCalledWith("reserve_number_credit", expect.objectContaining({ p_unit_cents: 15 }));
  });

  it("surfaces a refusal when empty or unsubscribed so the caller can stop before any provider work", async () => {
    state.rpc = vi.fn(async () => ({ data: { allowed: false, reason: "allowance_exhausted" }, error: null }));
    expect(await reserveNumberCredit(VENDOR, "sms_outbound_segment", 1, "k", { db: makeDb() as never })).toEqual({
      allowed: false,
      reason: "allowance_exhausted",
    });
  });

  it("rejects malformed usage before touching the database and throws on a database failure", async () => {
    state.rpc = vi.fn();
    await expect(reserveNumberCredit(VENDOR, "sms_outbound_segment", 0, "k", { db: makeDb() as never })).rejects.toThrow(/Invalid/);
    await expect(reserveNumberCredit(VENDOR, "sms_outbound_segment", 1, " ", { db: makeDb() as never })).rejects.toThrow(/Invalid/);
    await expect(reserveNumberCredit(VENDOR, "sms_outbound_segment", Number.NaN, "k", { db: makeDb() as never })).rejects.toThrow(/Invalid/);
    expect(state.rpc).not.toHaveBeenCalled();
    state.rpc = vi.fn(async () => ({ data: null, error: { code: "XX", message: "down" } }));
    await expect(reserveNumberCredit(VENDOR, "sms_outbound_segment", 1, "k", { db: makeDb() as never })).rejects.toThrow(/could not be reserved/);
  });

  it("verifies the balance shape instead of trusting it", async () => {
    state.rpc = vi.fn(async () => ({ data: { included_remaining_cents: -5, purchased_cents: 0, next_reset: "x" }, error: null }));
    await expect(getNumberCreditBalance(VENDOR, makeDb() as never)).rejects.toThrow(/verified/);
  });

  it("credit checkout needs an entitled subscription, a whole-dollar $5-$500 amount and the caller's own purchase id", async () => {
    const stripe = state.stripe as ReturnType<typeof makeStripe>;
    const input = { userId: VENDOR, email: "v@example.com", role: "vendor" as const, purchaseId: PURCHASE, creditCents: 2000, origin: "http://localhost" };

    state.db = makeDb();
    await expect(createNumberCreditCheckout(state.db as never, stripe as never, input)).rejects.toMatchObject({ status: 409 });

    state.db = makeDb({ number_subscriptions: [subRow()] });
    for (const creditCents of [499, 500.5, 50_100, 0, -500]) {
      await expect(createNumberCreditCheckout(state.db as never, stripe as never, { ...input, creditCents })).rejects.toMatchObject({ status: 400 });
    }
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();

    // Someone else's pending purchase id is not usable.
    state.db = makeDb({
      number_subscriptions: [subRow()],
      number_credit_purchases: [{ id: PURCHASE, owner_user_id: RESIDENT, credit_cents: 2000, status: "pending", created_at: new Date().toISOString() }],
    });
    await expect(createNumberCreditCheckout(state.db as never, stripe as never, input)).rejects.toMatchObject({ status: 400 });

    state.db = makeDb({ number_subscriptions: [subRow()] });
    const { url } = await createNumberCreditCheckout(state.db as never, stripe as never, input);
    expect(url).toBe("https://checkout.stripe.test/s");
    const [params, options] = stripe.checkout.sessions.create.mock.calls[0] as unknown as [Loose, Loose];
    expect(params).toMatchObject({
      mode: "payment",
      customer: "cus_vendor",
      client_reference_id: VENDOR,
      metadata: { purpose: NUMBER_CREDIT_PURPOSE, owner_user_id: VENDOR, purchase_id: PURCHASE, credit_cents: "2000" },
    });
    expect(params.line_items[0].price_data.unit_amount).toBe(2000);
    expect(params).not.toHaveProperty("saved_payment_method_options");
    expect(options.idempotencyKey).toBe(`number-credit:${VENDOR}:${PURCHASE}`);
  });

  it("the credit-checkout route is flag-gated, role-gated and validates its body", async () => {
    vi.stubEnv("NUMBER_SUBSCRIPTION_ENABLED", "");
    expect((await creditCheckoutRoute(req("/x", { creditCents: 2000, purchaseId: PURCHASE }))).status).toBe(404);
    vi.stubEnv("NUMBER_SUBSCRIPTION_ENABLED", "1");
    actAs(MANAGER, ["manager"]);
    expect((await creditCheckoutRoute(req("/x", { creditCents: 2000, purchaseId: PURCHASE }))).status).toBe(403);
    actAs(VENDOR, ["vendor"]);
    expect((await creditCheckoutRoute(req("/x", { creditCents: 123, purchaseId: PURCHASE }))).status).toBe(400);
    expect((await creditCheckoutRoute(req("/x", { creditCents: 2000, purchaseId: "nope" }))).status).toBe(400);
    state.db = makeDb({ number_subscriptions: [subRow()] });
    expect((await creditCheckoutRoute(req("/x", { creditCents: 2000, purchaseId: PURCHASE }))).status).toBe(200);
  });

  it("fulfils a verified purchase once through the signed webhook and acknowledges a bad payment without crediting", async () => {
    state.db = makeDb({ number_credit_purchases: [{ id: PURCHASE, owner_user_id: VENDOR, credit_cents: 2000, status: "pending" }] });
    state.rpc = vi.fn(async () => ({ data: true, error: null }));
    expect((await deliver("checkout.session.completed", creditSession())).status).toBe(200);
    expect(fulfillCalls()).toEqual([
      ["fulfill_number_credit_purchase", { p_purchase: PURCHASE, p_owner: VENDOR, p_session: "cs_credit", p_payment_intent: "pi_1", p_credit: 2000, p_event: "evt_1" }],
    ]);

    state.rpc = vi.fn(async () => ({ data: true, error: null }));
    for (const over of [
      { amount_total: 1000 },
      { client_reference_id: RESIDENT },
      { currency: "eur" },
      { total_details: { amount_discount: 100 } },
      { metadata: { purpose: NUMBER_CREDIT_PURPOSE, owner_user_id: RESIDENT, purchase_id: PURCHASE, credit_cents: "2000" }, client_reference_id: RESIDENT },
      { metadata: { purpose: NUMBER_CREDIT_PURPOSE, owner_user_id: VENDOR, purchase_id: PURCHASE, credit_cents: "99999" } },
    ]) {
      expect((await deliver("checkout.session.completed", creditSession(over))).status).toBe(200);
    }
    expect(fulfillCalls()).toHaveLength(0);
  });

  it("fulfilment surfaces a validation error and ignores unpaid sessions and other purposes", async () => {
    const db = makeDb({ number_credit_purchases: [{ id: PURCHASE, owner_user_id: VENDOR, credit_cents: 2000, status: "pending" }] }) as never;
    await expect(fulfillNumberCreditPurchase(db, creditSession({ amount_total: 1 }) as never, "e")).rejects.toBeInstanceOf(NumberCreditValidationError);
    expect(await fulfillNumberCreditPurchase(db, creditSession({ payment_status: "unpaid" }) as never, "e")).toBe(false);
    expect(await fulfillNumberCreditPurchase(db, creditSession({ metadata: { purpose: "other" } }) as never, "e")).toBe(false);
    state.rpc = vi.fn(async () => ({ data: false, error: null }));
    expect(await fulfillNumberCreditPurchase(db, creditSession() as never, "e")).toBe(false); // replay: already applied
  });

  it("reverses a number purchase once per refund event and ignores payments that are not ours", async () => {
    const db = makeDb({ number_credit_purchases: [{ id: PURCHASE, owner_user_id: VENDOR, credit_cents: 2000, stripe_payment_intent_id: "pi_1" }] }) as never;
    state.rpc = vi.fn(async () => ({ data: true, error: null }));
    expect(await reverseNumberCreditForPaymentIntent(db, "pi_1", "evt_r", { loadCharge: async () => ({ amount_refunded: 500 }) })).toBe(true);
    expect(state.rpc).toHaveBeenCalledWith("reverse_number_credit_purchase", { p_payment_intent: "pi_1", p_reversed: 500, p_event: "evt_r", p_reason: "refund" });
    expect(await reverseNumberCreditForPaymentIntent(db, "pi_1", "evt_d", { dispute: true, loadCharge: async () => ({ amount_refunded: 0 }) })).toBe(true);
    expect(state.rpc).toHaveBeenLastCalledWith("reverse_number_credit_purchase", expect.objectContaining({ p_reversed: 2000, p_reason: "dispute" }));
    state.rpc.mockClear();
    expect(await reverseNumberCreditForPaymentIntent(db, "pi_other", "evt_x", { loadCharge: async () => ({ amount_refunded: 1 }) })).toBe(false);
    expect(await reverseNumberCreditForPaymentIntent(db, null, "evt_x", { loadCharge: async () => ({ amount_refunded: 1 }) })).toBe(false);
    expect(state.rpc).not.toHaveBeenCalled();
  });
});

describe("return paths", () => {
  it("accepts only same-origin relative paths", () => {
    expect(safeNumberReturnPath("/vendor/settings?tab=number", "/vendor")).toBe("/vendor/settings?tab=number");
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil", "javascript:alert(1)", "vendor", "/a b", "/x://y", undefined, 7, "/" + "a".repeat(250)]) {
      expect(safeNumberReturnPath(bad, "/vendor")).toBe("/vendor");
    }
  });
});

describe("migration surface", () => {
  const sql = readFileSync(path.join(process.cwd(), "supabase", "migrations", "20261008200000_number_subscriptions.sql"), "utf8");
  const tables = ["number_subscriptions", "number_credit_accounts", "number_credit_usage_events", "number_credit_purchases", "number_credit_adjustments"];

  it("enables RLS on every table and gives client roles no write grant anywhere", () => {
    for (const table of tables) expect(sql).toContain(`alter table public.${table} enable row level security`);
    expect(sql).not.toMatch(/grant\s+(all|insert|update|delete)[^;]*to\s+[^;]*\b(authenticated|anon)\b/i);
    expect(sql).not.toMatch(/create policy[^;]*for\s+(all|insert|update|delete)/i);
    expect(sql).toMatch(/create policy number_subscriptions_select_own[\s\S]*for select to authenticated[\s\S]*auth\.uid\(\)/);
  });

  it("is idempotent", () => {
    expect(sql).not.toMatch(/create table (?!if not exists)/i);
    expect(sql).not.toMatch(/create function/i);
    expect(sql).toMatch(/drop policy if exists number_subscriptions_select_own/);
  });

  it("every function is service-role only", () => {
    const fns = [...sql.matchAll(/create or replace function public\.(\w+)/g)].map((m) => m[1]);
    expect(fns.length).toBeGreaterThanOrEqual(7);
    for (const fn of fns) {
      expect(sql).toMatch(new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public, anon, authenticated`));
      expect(sql).toMatch(new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role`));
    }
  });
});
