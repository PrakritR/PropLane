/**
 * GET /api/admin/accounts/[id]/billing: one manager account's billing for the admin record.
 *
 * Pinned here: the id is input, not authorization (admin gate first, UUID before any query); every
 * Stripe-derived number comes from Stripe through the server (paid to date = paid invoices for THIS
 * customer); the plan is the resolver's, not the stored column; and a Stripe outage degrades to the
 * database's facts with `stripe.available: false` - never to a made-up $0 and never to its message.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminFakeDb, type AdminFakeDb, type Row } from "../helpers/admin-fake-db";

const isAdminUser = vi.fn();
const getUser = vi.fn();
const serviceRoleFactory = vi.fn();

const stripe = {
  subscriptions: { retrieve: vi.fn() },
  promotionCodes: { retrieve: vi.fn() },
  invoices: { list: vi.fn() },
};

vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: (...a: unknown[]) => isAdminUser(...a) }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser } }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => serviceRoleFactory() }));
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripe, isStripeLiveMode: () => false }));

const { GET } = await import("@/app/api/admin/accounts/[id]/billing/route");
const { COMPLIMENTARY_COUPON_ID } = await import("@/lib/admin/admin-billing-constants");

const MGR = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

let db: AdminFakeDb;
const call = (id: string) =>
  GET(new Request(`https://prop-lane.space/api/admin/accounts/${id}/billing`), { params: Promise.resolve({ id }) });
const asAdmin = () => {
  getUser.mockResolvedValue({ data: { user: { id: "admin-1" } } });
  isAdminUser.mockResolvedValue(true);
};
const seconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);

function seed(purchases: Row[], settings: Row[] = []): Record<string, Row[]> {
  return { manager_purchases: purchases, manager_automation_settings: settings };
}

const proMonthly = (): Row => ({
  id: "p1",
  user_id: MGR,
  tier: "pro",
  billing: "monthly",
  paid_at: "2026-09-12T00:00:00.000Z",
  stripe_customer_id: "cus_1",
  stripe_subscription_id: "sub_1",
  stripe_checkout_session_id: "cs_1",
});

const invoice = (id: string, paid: number, over: Record<string, unknown> = {}) => ({
  id,
  number: `INV-${id}`,
  status: "paid",
  amount_paid: paid,
  currency: "usd",
  created: seconds("2026-09-12T00:00:00.000Z"),
  status_transitions: { paid_at: seconds("2026-09-12T00:05:00.000Z") },
  hosted_invoice_url: `https://invoice.stripe.com/${id}`,
  lines: { data: [{ description: "Pro monthly" }] },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  isAdminUser.mockReset();
  getUser.mockReset();
  serviceRoleFactory.mockReset();
  db = createAdminFakeDb(seed([proMonthly()]));
  serviceRoleFactory.mockImplementation(() => db);
  stripe.subscriptions.retrieve.mockResolvedValue({
    id: "sub_1",
    status: "active",
    start_date: seconds("2026-09-12T00:00:00.000Z"),
    trial_end: null,
    cancel_at_period_end: false,
    currency: "usd",
    customer: "cus_1",
    discounts: [],
    items: { data: [{ current_period_end: seconds("2026-11-12T00:00:00.000Z"), price: { recurring: { interval: "month" } } }] },
  });
  stripe.invoices.list.mockResolvedValue({ data: [invoice("a", 4900), invoice("b", 4900), invoice("c", 4900)] });
  stripe.promotionCodes.retrieve.mockResolvedValue({ id: "promo_1", code: "FREEFIRST" });
});

describe("who may call it", () => {
  it("is 401 signed out and 403 without the admin role, before any read", async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    expect((await call(MGR)).status).toBe(401);
    getUser.mockResolvedValue({ data: { user: { id: "mgr" } } });
    isAdminUser.mockResolvedValue(false);
    expect((await call(MGR)).status).toBe(403);
    expect(serviceRoleFactory).not.toHaveBeenCalled();
    expect(stripe.invoices.list).not.toHaveBeenCalled();
  });

  it("refuses an id that is not a UUID without querying or calling Stripe", async () => {
    asAdmin();
    for (const bad of ["1", "x,user_id.eq.1", "../../etc"]) expect((await call(bad)).status).toBe(404);
    expect(db.touched.size).toBe(0);
    expect(stripe.invoices.list).not.toHaveBeenCalled();
  });
});

describe("a Stripe-billed account", () => {
  it("reads the subscription facts from Stripe and paid-to-date from this customer's paid invoices", async () => {
    asAdmin();
    const res = await call(MGR);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = await res.json();
    expect(body.plan).toMatchObject({
      tier: "pro",
      planLabel: "Pro monthly",
      source: "stripe",
      sourceLabel: "Stripe",
      status: "Active",
      statusTone: "ok",
      since: "2026-09-12T00:00:00.000Z",
      renewsAt: "2026-11-12T00:00:00.000Z",
      renewsLabel: "Renews",
      trialEndsAt: null,
      complimentary: false,
      promoCode: null,
    });
    expect(stripe.invoices.list).toHaveBeenCalledWith({ customer: "cus_1", limit: 100 });
    expect(body.paidToDateCents).toBe(14700);
    expect(body.payments).toHaveLength(3);
    expect(body.payments[0]).toMatchObject({
      description: "Pro monthly",
      amountCents: 4900,
      number: "INV-a",
      invoiceUrl: "https://invoice.stripe.com/a",
    });
    expect(body.stripe).toMatchObject({
      linked: true,
      available: true,
      testMode: true,
      customerUrl: "https://dashboard.stripe.com/test/customers/cus_1",
    });
  });

  it("counts only paid invoices with money in them (not drafts, voids or $0 comp invoices)", async () => {
    asAdmin();
    stripe.invoices.list.mockResolvedValue({
      data: [
        invoice("a", 4900),
        invoice("draft", 0, { status: "draft" }),
        invoice("void", 4900, { status: "void" }),
        invoice("zero", 0),
      ],
    });
    const body = await (await call(MGR)).json();
    expect(body.paidToDateCents).toBe(4900);
    expect(body.payments.map((p: { id: string }) => p.id)).toEqual(["a"]);
  });

  it("shows the live trial end, a promo code, and complimentary from the subscription itself", async () => {
    asAdmin();
    stripe.subscriptions.retrieve.mockResolvedValue({
      id: "sub_1",
      status: "trialing",
      start_date: seconds("2026-10-01T00:00:00.000Z"),
      trial_end: seconds("2026-10-15T23:59:59.000Z"),
      cancel_at_period_end: false,
      currency: "usd",
      customer: "cus_1",
      discounts: [
        { id: "di_1", source: { type: "coupon", coupon: "c_first" }, promotion_code: "promo_1" },
        { id: "di_2", source: { type: "coupon", coupon: COMPLIMENTARY_COUPON_ID } },
      ],
      items: { data: [{ current_period_end: seconds("2026-10-15T23:59:59.000Z"), price: { recurring: { interval: "month" } } }] },
    });
    const body = await (await call(MGR)).json();
    expect(body.plan).toMatchObject({
      status: "Trial",
      statusTone: null,
      trialEndsAt: "2026-10-15T23:59:59.000Z",
      promoCode: "FREEFIRST",
      complimentary: true,
    });
  });

  it("says Ends, not Renews, for a subscription set to cancel", async () => {
    asAdmin();
    stripe.subscriptions.retrieve.mockResolvedValue({
      id: "sub_1",
      status: "active",
      start_date: seconds("2026-09-12T00:00:00.000Z"),
      trial_end: null,
      cancel_at_period_end: true,
      customer: "cus_1",
      discounts: [],
      items: { data: [{ current_period_end: seconds("2026-11-12T00:00:00.000Z"), price: { recurring: { interval: "year" } } }] },
    });
    const body = await (await call(MGR)).json();
    expect(body.plan).toMatchObject({ renewsLabel: "Ends", planLabel: "Pro annual" });
  });

  it("does not turn a Stripe outage into $0: the database facts stay, the Stripe ones are null", async () => {
    asAdmin();
    stripe.subscriptions.retrieve.mockRejectedValue(new Error("Invalid API Key provided: sk_test_secret"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await call(MGR);
    spy.mockRestore();
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain("sk_test_secret");
    const body = JSON.parse(text);
    expect(body.stripe).toMatchObject({ linked: true, available: false });
    expect(body.paidToDateCents).toBeNull();
    expect(body.payments).toEqual([]);
    expect(body.plan).toMatchObject({ tier: "pro", source: "stripe" });
  });

  it("never returns another customer's invoices: the list is keyed on this account's own customer id", async () => {
    asAdmin();
    db = createAdminFakeDb(seed([proMonthly(), { ...proMonthly(), id: "p9", user_id: OTHER, stripe_customer_id: "cus_other" }]));
    serviceRoleFactory.mockImplementation(() => db);
    await call(MGR);
    expect(stripe.invoices.list).toHaveBeenCalledTimes(1);
    expect(stripe.invoices.list).toHaveBeenCalledWith({ customer: "cus_1", limit: 100 });
  });
});

describe("accounts with no subscription", () => {
  it("a live signup trial reads from the date the resolver derives, and never calls Stripe", async () => {
    asAdmin();
    db = createAdminFakeDb(
      seed([
        { id: "p2", user_id: MGR, tier: "pro", billing: "trial", paid_at: new Date().toISOString(), stripe_checkout_session_id: "cs_t" },
      ]),
    );
    serviceRoleFactory.mockImplementation(() => db);
    const body = await (await call(MGR)).json();
    expect(body.plan).toMatchObject({ source: "trial", sourceLabel: "Trial", status: "Trial", planLabel: "Pro" });
    expect(body.plan.trialEndsAt).toEqual(expect.any(String));
    expect(body.paidToDateCents).toBeNull();
    expect(body.stripe).toMatchObject({ linked: false, available: true });
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
    expect(stripe.invoices.list).not.toHaveBeenCalled();
  });

  it("a lapsed trial is Free to the product and says the trial ended", async () => {
    asAdmin();
    db = createAdminFakeDb(
      seed([{ id: "p2", user_id: MGR, tier: "pro", billing: "trial", paid_at: "2026-01-01T00:00:00.000Z", stripe_checkout_session_id: "cs_t" }]),
    );
    serviceRoleFactory.mockImplementation(() => db);
    const body = await (await call(MGR)).json();
    expect(body.plan).toMatchObject({ tier: "free", status: "Trial ended", statusTone: "bad" });
  });

  it("an account that never bought anything is Free with no source", async () => {
    asAdmin();
    db = createAdminFakeDb(seed([]));
    serviceRoleFactory.mockImplementation(() => db);
    const body = await (await call(MGR)).json();
    expect(body.plan).toMatchObject({ tier: "free", source: "none", sourceLabel: "None", status: "Free", complimentary: false });
  });

  it("complimentary comes from the staff record when there is no subscription to ask", async () => {
    asAdmin();
    db = createAdminFakeDb(
      seed(
        [{ id: "p3", user_id: MGR, tier: "pro", billing: "admin", paid_at: "2026-09-01T00:00:00.000Z", stripe_checkout_session_id: "admin_AXIS-1" }],
        [{ manager_user_id: MGR, row_data: { billingOverrides: { complimentary: true, propertyCap: 12 } } }],
      ),
    );
    serviceRoleFactory.mockImplementation(() => db);
    const body = await (await call(MGR)).json();
    expect(body.plan).toMatchObject({ source: "admin", complimentary: true, status: "Active" });
    expect(body.limits).toEqual({ propertyCap: 12, propertyCapIsOverride: true });
  });

  it("reports a property cap that follows the plan when none is pinned", async () => {
    asAdmin();
    db = createAdminFakeDb(seed([]));
    serviceRoleFactory.mockImplementation(() => db);
    const body = await (await call(MGR)).json();
    expect(body.limits.propertyCapIsOverride).toBe(false);
  });
});

describe("failure", () => {
  it("is a generic 500 when the purchase cannot be read - never a Free default, never the raw message", async () => {
    asAdmin();
    db = createAdminFakeDb(seed([proMonthly()]));
    const real = db.from.bind(db);
    db.from = (table: string) => {
      if (table === "manager_purchases") {
        const q: Record<string, unknown> = {
          select: () => q,
          eq: () => q,
          then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: { message: "relation secret_table failed" } }),
        };
        return q;
      }
      return real(table);
    };
    serviceRoleFactory.mockImplementation(() => db);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await call(MGR);
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("secret_table");
  });
});
