import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `manager_purchases` holds ONE reservation per manager id: the one Checkout session whose payment may be
 * fulfilled. Replacing it must (1) close the session it replaces at Stripe, (2) swap only with a
 * compare-and-swap on the id that was read, (3) never overwrite a complete (paid or still-settling) session,
 * and (4) leave no open session behind that the caller was not handed. Everything here is mocked - no Stripe,
 * no Supabase.
 */
const mocks = vi.hoisted(() => ({ db: null as unknown, stripe: null as unknown, classification: vi.fn() }));

vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => mocks.db }));
vi.mock("@/lib/stripe", () => ({ getStripe: () => mocks.stripe }));
vi.mock("@/lib/test-workspaces/index.server", () => ({ resolveTestWorkspaceClassification: mocks.classification }));
vi.mock("@/lib/test-workspaces/effects.server", () => ({ captureTestWorkspaceEffectForUser: vi.fn() }));

import type Stripe from "stripe";
import { RATE_CARD } from "@/lib/billing/rate-card";
import { resolveManagerCheckoutPurchase } from "@/lib/manager-purchase-from-session";
import { createManagerCheckoutSession } from "@/lib/stripe/manager-checkout";
import { clearManagerPriceCache } from "@/lib/stripe/resolve-manager-price";

const MANAGER_ID = "MGR-1";
const USER_ID = "owner-1";
const EMAIL = "manager@example.com";

type Row = Record<string, unknown>;

/** A `manager_purchases` stand-in that honors the filters it is sent, with atomic update / insert-if-absent. */
function fakeDb(initial: Row[], opts: { failWrites?: () => boolean } = {}) {
  const rows: Row[] = initial.map((row) => ({ ...row }));
  let ids = 0;
  const purchases = () => {
    const filters: Array<(row: Row) => boolean> = [];
    let patch: Row | null = null;
    const matching = () => rows.filter((row) => filters.every((f) => f(row)));
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (column: string, value: unknown) => (filters.push((r) => r[column] === value), q),
      is: (column: string, value: unknown) => (filters.push((r) => (r[column] ?? null) === value), q),
      not: (column: string) => (filters.push((r) => r[column] != null), q),
      or: () => q,
      limit: () => q,
      update: (value: Row) => ((patch = value), q),
      maybeSingle: async () => {
        if (patch) {
          if (opts.failWrites?.()) return { data: null, error: { message: "db down" } };
          const hit = matching()[0];
          if (!hit) return { data: null, error: null };
          Object.assign(hit, patch);
          return { data: { id: hit.id }, error: null };
        }
        const hit = matching()[0];
        return { data: hit ? { ...hit } : null, error: null };
      },
      upsert: (row: Row, options: { ignoreDuplicates?: boolean }) => ({
        select: async () => {
          if (opts.failWrites?.()) return { data: null, error: { message: "db down" } };
          if (rows.some((r) => r.manager_id === row.manager_id)) {
            if (options.ignoreDuplicates) return { data: [], error: null };
            Object.assign(rows.find((r) => r.manager_id === row.manager_id)!, row);
          } else {
            rows.push({ id: `purchase-${++ids}`, ...row });
          }
          return { data: [{ id: rows.find((r) => r.manager_id === row.manager_id)!.id }], error: null };
        },
      }),
    };
    return q;
  };
  const other = () => {
    const q: Record<string, unknown> = {
      select: () => q, eq: () => q, not: () => q, limit: () => q, is: () => q, or: () => q,
      in: async () => ({ data: [], error: null }),
      maybeSingle: async () => ({ data: null, error: null }),
    };
    return q;
  };
  return { rows, from: (table: string) => (table === "manager_purchases" ? purchases() : other()) };
}

type FakeSession = {
  id: string;
  status: "open" | "complete" | "expired";
  payment_status: "paid" | "unpaid" | "no_payment_required";
  metadata: Record<string, string>;
  customer_email?: string;
  url?: string;
  client_secret?: string;
};

function barrier(parties: number) {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  return async () => {
    if (++arrived >= parties) release();
    await gate;
  };
}

function fakeStripe(opts: { beforeCreateReturns?: () => Promise<void>; onExpire?: (s: FakeSession) => void; failExpire?: boolean } = {}) {
  const sessions = new Map<string, FakeSession>();
  let created = 0;
  const get = (id: string) => {
    const s = sessions.get(id);
    if (!s) throw new Error(`No such session ${id}`);
    return s;
  };
  const client = {
    checkout: {
      sessions: {
        create: vi.fn(async (params: { metadata: Record<string, string> }) => {
          const id = `cs_new_${++created}`;
          sessions.set(id, {
            id, status: "open", payment_status: "unpaid", metadata: params.metadata, customer_email: EMAIL,
            url: `https://checkout.test/${id}`, client_secret: `secret_${id}`,
          });
          await opts.beforeCreateReturns?.();
          return { ...get(id) };
        }),
        retrieve: vi.fn(async (id: string) => ({ ...get(id) })),
        expire: vi.fn(async (id: string) => {
          const s = get(id);
          opts.onExpire?.(s);
          if (opts.failExpire || s.status !== "open") throw new Error("Only an open session can be expired.");
          s.status = "expired";
          return { ...s };
        }),
      },
    },
    prices: {
      retrieve: vi.fn(async () => ({
        id: "price_pro_monthly", active: true, currency: "usd", type: "recurring", unit_amount: RATE_CARD.pro.floorMonthlyCents,
        recurring: { interval: "month", interval_count: 1 }, product: "prod_x",
      })),
    },
    products: { retrieve: vi.fn(async () => ({ id: "prod_x", metadata: { axis_plan: "axis_pro" } })) },
  };
  return { sessions, client };
}

const seedPrior = (stripe: ReturnType<typeof fakeStripe>, patch: Partial<FakeSession> = {}) =>
  stripe.sessions.set("cs_prior", {
    id: "cs_prior", status: "open", payment_status: "unpaid", customer_email: EMAIL,
    metadata: { manager_id: MANAGER_ID, userId: USER_ID, email: EMAIL }, ...patch,
  });

const priorRow = (): Row => ({ id: "purchase-prior", user_id: USER_ID, manager_id: MANAGER_ID, email: EMAIL, full_name: null, stripe_checkout_session_id: "cs_prior" });

function checkout(embedded = false) {
  return createManagerCheckoutSession({
    tier: "pro", billing: "monthly", email: EMAIL, userId: USER_ID, managerId: MANAGER_ID, embedded,
    req: new Request("http://localhost/partner/pricing"),
  });
}

/** What the signed webhook would resolve for a PAID session: the same function the route calls. */
function webhookResolution(db: ReturnType<typeof fakeDb>, stripe: ReturnType<typeof fakeStripe>, id: string) {
  const session = { ...stripe.sessions.get(id)!, status: "complete", payment_status: "paid", mode: "subscription" } as unknown as Stripe.Checkout.Session;
  return resolveManagerCheckoutPurchase(db as never, session);
}

const live = (stripe: ReturnType<typeof fakeStripe>) => [...stripe.sessions.values()].filter((s) => s.status === "open").map((s) => s.id);

beforeEach(() => {
  vi.clearAllMocks();
  clearManagerPriceCache();
  process.env.STRIPE_PRICE_PRO_MONTHLY = "price_pro_monthly";
  mocks.classification.mockResolvedValue({ kind: "normal" });
});

describe("replacing a reserved manager checkout", () => {
  it("expires the first session and stores the second", async () => {
    const stripe = fakeStripe();
    const db = fakeDb([]);
    mocks.db = db; mocks.stripe = stripe.client;

    const first = await checkout();
    const second = await checkout();

    expect(first).toMatchObject({ ok: true, sessionId: "cs_new_1" });
    expect(second).toMatchObject({ ok: true, sessionId: "cs_new_2" });
    expect(stripe.sessions.get("cs_new_1")!.status).toBe("expired");
    expect(live(stripe)).toEqual(["cs_new_2"]);
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]!.stripe_checkout_session_id).toBe("cs_new_2");
    // The first can no longer be paid; the second is the one the webhook resolves.
    await expect(webhookResolution(db, stripe, "cs_new_1")).rejects.toThrow();
    await expect(webhookResolution(db, stripe, "cs_new_2")).resolves.toMatchObject({ sourceSessionId: "cs_new_2", userId: USER_ID });
  });

  it("pins the authenticated owner and manager in the new session's metadata", async () => {
    const stripe = fakeStripe();
    mocks.db = fakeDb([priorRow()]); mocks.stripe = stripe.client;
    seedPrior(stripe);
    await checkout();
    expect(stripe.client.checkout.sessions.create.mock.calls[0]![0].metadata).toMatchObject({ userId: USER_ID, manager_id: MANAGER_ID });
  });

  it("refuses the new checkout when Stripe will not expire the old one", async () => {
    const stripe = fakeStripe({ failExpire: true });
    const db = fakeDb([priorRow()]);
    mocks.db = db; mocks.stripe = stripe.client;
    seedPrior(stripe);

    const result = await checkout();

    expect(result).toMatchObject({ ok: false, status: 503 });
    expect(stripe.client.checkout.sessions.create).not.toHaveBeenCalled();
    expect(db.rows[0]!.stripe_checkout_session_id).toBe("cs_prior");
    expect(stripe.sessions.get("cs_prior")!.status).toBe("open");
  });

  it("refuses when the old session cannot be read at all (state unknown is not expired)", async () => {
    const stripe = fakeStripe();
    const db = fakeDb([priorRow()]);
    mocks.db = db; mocks.stripe = stripe.client; // cs_prior is not known to Stripe -> retrieve throws

    expect(await checkout()).toMatchObject({ ok: false, status: 503 });
    expect(stripe.client.checkout.sessions.create).not.toHaveBeenCalled();
    expect(db.rows[0]!.stripe_checkout_session_id).toBe("cs_prior");
  });

  it.each([
    ["paid", "paid"],
    ["complete but unpaid (async settlement pending)", "unpaid"],
  ] as const)("never overwrites a complete prior session: %s", async (_label, payment) => {
    const stripe = fakeStripe();
    const db = fakeDb([priorRow()]);
    mocks.db = db; mocks.stripe = stripe.client;
    seedPrior(stripe, { status: "complete", payment_status: payment });

    const result = await checkout();

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(stripe.client.checkout.sessions.create).not.toHaveBeenCalled();
    expect(stripe.client.checkout.sessions.expire).not.toHaveBeenCalled();
    expect(db.rows[0]!.stripe_checkout_session_id).toBe("cs_prior");
    // Its payment still resolves to the stored reservation.
    await expect(webhookResolution(db, stripe, "cs_prior")).resolves.toMatchObject({ sourceSessionId: "cs_prior" });
  });

  it("refuses a reservation that belongs to another login or email", async () => {
    const stripe = fakeStripe();
    const db = fakeDb([{ ...priorRow(), user_id: "someone-else", email: "other@example.com" }]);
    mocks.db = db; mocks.stripe = stripe.client;
    seedPrior(stripe);
    expect(await checkout()).toMatchObject({ ok: false, status: 409 });
    expect(stripe.client.checkout.sessions.create).not.toHaveBeenCalled();
    expect(stripe.client.checkout.sessions.expire).not.toHaveBeenCalled();
  });

  it.each([
    ["with a prior row", true],
    ["with no prior row", false],
  ])("expires the new session when the reservation write fails (%s)", async (_label, withPrior) => {
    const stripe = fakeStripe();
    const db = fakeDb(withPrior ? [priorRow()] : [], { failWrites: () => true });
    mocks.db = db; mocks.stripe = stripe.client;
    if (withPrior) seedPrior(stripe);

    const result = await checkout();

    expect(result).toMatchObject({ ok: false, status: 500 });
    expect(result).not.toHaveProperty("url");
    expect(stripe.sessions.get("cs_new_1")!.status).toBe("expired");
    expect(live(stripe)).toEqual([]);
    if (withPrior) expect(db.rows[0]!.stripe_checkout_session_id).toBe("cs_prior");
    else expect(db.rows).toHaveLength(0);
  });
});

describe("two concurrent checkouts for the same manager", () => {
  async function race(withPrior: boolean) {
    const gate = barrier(2);
    const stripe = fakeStripe({ beforeCreateReturns: gate });
    const db = fakeDb(withPrior ? [priorRow()] : []);
    mocks.db = db; mocks.stripe = stripe.client;
    if (withPrior) seedPrior(stripe);
    // Both callers have read the same reservation and created their session before either one writes.
    const results = await Promise.all([checkout(), checkout()]);
    return { stripe, db, results };
  }

  it.each([
    ["CAS replace (a prior reservation exists)", true],
    ["insert race (no prior row)", false],
  ])("%s: one winner is exposed, the loser errors and is expired, one live session is stored", async (_label, withPrior) => {
    const { stripe, db, results } = await race(withPrior);

    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toMatchObject({ ok: false, status: 409 });
    // The loser got no URL / secret to pay.
    expect(losers[0]).not.toHaveProperty("url");
    expect(losers[0]).not.toHaveProperty("clientSecret");

    const winnerId = (winners[0] as { sessionId: string }).sessionId;
    const loserId = ["cs_new_1", "cs_new_2"].find((id) => id !== winnerId)!;
    expect(stripe.sessions.get(loserId)!.status).toBe("expired");
    expect(live(stripe)).toEqual([winnerId]);
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]!.stripe_checkout_session_id).toBe(winnerId);
    if (withPrior) expect(stripe.sessions.get("cs_prior")!.status).toBe("expired");

    // A paid webhook for the winner resolves; one for the loser (or the replaced prior) never does,
    // in either delivery order.
    const unmatched = withPrior ? [loserId, "cs_prior"] : [loserId];
    for (const order of [[winnerId, ...unmatched], [...unmatched, winnerId]]) {
      for (const id of order) {
        if (id === winnerId) await expect(webhookResolution(db, stripe, id)).resolves.toMatchObject({ sourceSessionId: winnerId });
        else await expect(webhookResolution(db, stripe, id)).rejects.toThrow();
      }
    }
  });

  it("a prior session that gets PAID while both callers try to replace it is never overwritten", async () => {
    // The customer's payment lands between the callers' read and their expire: the expire fails because the
    // session is now complete, so both callers must refuse and leave the reservation on the paid session.
    const gate = barrier(2);
    const stripe = fakeStripe({
      beforeCreateReturns: gate,
      onExpire: (s) => {
        if (s.id === "cs_prior") Object.assign(s, { status: "complete", payment_status: "paid" });
      },
    });
    const db = fakeDb([priorRow()]);
    mocks.db = db; mocks.stripe = stripe.client;
    seedPrior(stripe);

    const results = await Promise.all([checkout(), checkout()]);

    for (const result of results) expect(result).toMatchObject({ ok: false });
    expect(stripe.client.checkout.sessions.create).not.toHaveBeenCalled();
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]!.stripe_checkout_session_id).toBe("cs_prior");
    // The paid prior is still fulfillable, whichever order its webhook arrives in.
    await expect(webhookResolution(db, stripe, "cs_prior")).resolves.toMatchObject({ sourceSessionId: "cs_prior" });
    await expect(webhookResolution(db, stripe, "cs_prior")).resolves.toMatchObject({ sourceSessionId: "cs_prior" });
  });
});

describe("a Pro signup trial's internal reservation is replaceable", () => {
  // finalizePendingManagerFreeTier stores billing=trial with an internal `axis_intent_<uuid>` id, may carry
  // paid_at, and has no Stripe session behind it. It is not a paid Stripe session: Stripe is never asked about
  // it, and a new checkout replaces it under the exact compare-and-swap on that stored id.
  const trialRow = (): Row => ({
    id: "purchase-trial", user_id: USER_ID, manager_id: MANAGER_ID, email: EMAIL, full_name: null,
    tier: "pro", billing: "trial", paid_at: "2026-10-01T00:00:00.000Z",
    stripe_checkout_session_id: "axis_intent_6f1c2d3e-0000-4000-8000-000000000001",
  });

  it("replaces it under CAS and returns the checkout URL, never calling Stripe about the internal id", async () => {
    const stripe = fakeStripe();
    const db = fakeDb([trialRow()]);
    mocks.db = db; mocks.stripe = stripe.client;

    const result = await checkout();

    expect(result).toMatchObject({ ok: true, embedded: false, sessionId: "cs_new_1", url: "https://checkout.test/cs_new_1" });
    expect(stripe.client.checkout.sessions.retrieve).not.toHaveBeenCalled();
    expect(stripe.client.checkout.sessions.expire).not.toHaveBeenCalled();
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]!.stripe_checkout_session_id).toBe("cs_new_1");
    expect(live(stripe)).toEqual(["cs_new_1"]);
    await expect(webhookResolution(db, stripe, "cs_new_1")).resolves.toMatchObject({ sourceSessionId: "cs_new_1" });
  });

  it("with a concurrent second create, exactly one wins and the loser's session is expired", async () => {
    const gate = barrier(2);
    const stripe = fakeStripe({ beforeCreateReturns: gate });
    const db = fakeDb([trialRow()]);
    mocks.db = db; mocks.stripe = stripe.client;

    const results = await Promise.all([checkout(), checkout()]);

    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toEqual([expect.objectContaining({ ok: false, status: 409 })]);
    const winnerId = (winners[0] as { sessionId: string }).sessionId;
    const loserId = ["cs_new_1", "cs_new_2"].find((id) => id !== winnerId)!;
    expect(stripe.sessions.get(loserId)!.status).toBe("expired");
    expect(live(stripe)).toEqual([winnerId]);
    expect(db.rows[0]!.stripe_checkout_session_id).toBe(winnerId);
    // Stripe was only ever asked to expire the loser's own new session.
    expect(stripe.client.checkout.sessions.expire.mock.calls.map((c) => c[0])).toEqual([loserId]);
    expect(stripe.client.checkout.sessions.retrieve).not.toHaveBeenCalled();
  });
});

describe("a live NON-Stripe entitlement is never replaced or reserved over", () => {
  /**
   * Every non-Stripe grant synthesizes its own reservation id (`apple_iap_`, `admin_portal_`,
   * `axis_waiver_`), which `closePriorCheckoutSession` short-circuits past because there is no `cs_`
   * session to close. Without its own guard the CAS then swapped a live Apple/admin/waiver plan's id
   * for a fresh PAYABLE Stripe session, and on payment the same row grew a `stripe_subscription_id`
   * beside the Apple transaction: billed twice, with two reconcilers fighting over one tier.
   */
  const entitled = (patch: Row): Row => ({
    id: "purchase-entitled", user_id: USER_ID, manager_id: MANAGER_ID, email: EMAIL, full_name: null,
    tier: "business", billing: "monthly", paid_at: "2026-09-01T00:00:00.000Z", ...patch,
  });

  const cases: Array<[string, Row]> = [
    ["a live Apple IAP subscription", entitled({
      stripe_checkout_session_id: "apple_iap_1000000999",
      apple_original_transaction_id: "1000000999",
    })],
    ["an admin-granted plan", entitled({ stripe_checkout_session_id: `admin_portal_business_${USER_ID}` })],
    ["a 100% waiver", entitled({ stripe_checkout_session_id: `axis_waiver_business_${USER_ID}` })],
    ["a paid tier settled against no Stripe session at all", entitled({ stripe_checkout_session_id: "" })],
    ["an Apple transaction on a row whose session id looks ordinary", entitled({
      stripe_checkout_session_id: "cs_prior", apple_original_transaction_id: "1000000999",
    })],
  ];

  for (const [label, row] of cases) {
    it(`refuses ${label} with 409 and creates no Stripe session`, async () => {
      const stripe = fakeStripe();
      const db = fakeDb([row]);
      mocks.db = db; mocks.stripe = stripe.client;
      seedPrior(stripe);

      const result = await checkout();

      expect(result).toMatchObject({ ok: false, status: 409 });
      expect((result as { error: string }).error).toMatch(/already have an active plan/i);
      expect(stripe.client.checkout.sessions.create).not.toHaveBeenCalled();
      expect(stripe.client.checkout.sessions.expire).not.toHaveBeenCalled();
      // The reservation id is exactly what it was.
      expect(db.rows[0]!.stripe_checkout_session_id).toBe(row.stripe_checkout_session_id);
    });
  }

  /**
   * A live Stripe subscription used to be protected only by `closePriorCheckoutSession` refusing on
   * an unreadable prior session. Once a definitive `resource_missing` reads as "gone" and lets the
   * CAS proceed, that protection disappears — so the entitlement guard has to name it.
   */
  const subscribed = (patch: Row): Row => ({
    id: "purchase-subscribed", user_id: USER_ID, manager_id: MANAGER_ID, email: EMAIL, full_name: null,
    tier: "pro", billing: "monthly", paid_at: "2026-09-01T00:00:00.000Z",
    stripe_checkout_session_id: "cs_prior", stripe_subscription_id: "sub_live", ...patch,
  });

  for (const status of ["active", "trialing", "past_due", "unpaid"]) {
    it(`refuses a live ${status} Stripe subscription even when the prior session is gone`, async () => {
      const stripe = fakeStripe();
      const db = fakeDb([subscribed({ subscription_status: status })]);
      mocks.db = db; mocks.stripe = stripe.client;
      stripe.client.checkout.sessions.retrieve.mockRejectedValue(
        Object.assign(new Error("No such checkout.session: cs_prior"), {
          code: "resource_missing", statusCode: 404, type: "StripeInvalidRequestError",
        }),
      );

      const result = await checkout();

      expect(result).toMatchObject({ ok: false, status: 409 });
      expect((result as { error: string }).error).toMatch(/already have an active plan/i);
      expect(stripe.client.checkout.sessions.create).not.toHaveBeenCalled();
      // Stripe is never even asked: the refusal happens before any session work.
      expect(stripe.client.checkout.sessions.retrieve).not.toHaveBeenCalled();
      expect(db.rows[0]!.stripe_checkout_session_id).toBe("cs_prior");
    });
  }

  it("refuses a subscription id whose status cannot be read, since that cannot disprove a live plan", async () => {
    const stripe = fakeStripe();
    // `subscription_status` arrives in migration 20261020130000; code can reach a database without it.
    const db = fakeDb([subscribed({ subscription_status: null })]);
    mocks.db = db; mocks.stripe = stripe.client;
    seedPrior(stripe);

    const result = await checkout();

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(stripe.client.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("still replaces a reservation whose subscription Stripe has already cancelled", async () => {
    const stripe = fakeStripe();
    // Every cancellation path writes tier free and clears the id; a lingering dead id is not a plan.
    const db = fakeDb([subscribed({ tier: "free", subscription_status: "canceled" })]);
    mocks.db = db; mocks.stripe = stripe.client;
    seedPrior(stripe);

    await expect(checkout()).resolves.toMatchObject({ ok: true, sessionId: "cs_new_1" });
    expect(db.rows[0]!.stripe_checkout_session_id).toBe("cs_new_1");
  });

  it("still lets a signup trial with no subscription behind it through", async () => {
    const stripe = fakeStripe();
    const db = fakeDb([entitled({
      tier: "pro", billing: "trial",
      stripe_checkout_session_id: "axis_intent_6f1c2d3e-0000-4000-8000-000000000002",
      stripe_subscription_id: null, apple_original_transaction_id: null,
    })]);
    mocks.db = db; mocks.stripe = stripe.client;

    await expect(checkout()).resolves.toMatchObject({ ok: true, sessionId: "cs_new_1" });
    expect(db.rows[0]!.stripe_checkout_session_id).toBe("cs_new_1");
  });

  it("still lets a free-tier row through", async () => {
    const stripe = fakeStripe();
    const db = fakeDb([entitled({ tier: "free", billing: "monthly", stripe_checkout_session_id: "axis_intent_free" })]);
    mocks.db = db; mocks.stripe = stripe.client;
    await expect(checkout()).resolves.toMatchObject({ ok: true, sessionId: "cs_new_1" });
  });
});

describe("an unretrievable prior session does not wedge checkout forever", () => {
  /** Stripe's own shape for "that id does not exist on this account". */
  const resourceMissing = () =>
    Object.assign(new Error("No such checkout.session: cs_prior"), {
      code: "resource_missing", statusCode: 404, type: "StripeInvalidRequestError",
    });

  it("treats resource_missing as nothing left to close and replaces the reservation", async () => {
    const stripe = fakeStripe();
    const db = fakeDb([priorRow()]);
    mocks.db = db; mocks.stripe = stripe.client;
    // `cs_prior` is stored but no longer readable (aged out, a key rotation, another Stripe mode).
    stripe.client.checkout.sessions.retrieve.mockRejectedValue(resourceMissing());

    const result = await checkout();

    expect(result).toMatchObject({ ok: true, sessionId: "cs_new_1" });
    expect(db.rows[0]!.stripe_checkout_session_id).toBe("cs_new_1");
    expect(stripe.client.checkout.sessions.expire).not.toHaveBeenCalled();
  });

  it("keeps refusing when the read fails for any other reason", async () => {
    const stripe = fakeStripe();
    const db = fakeDb([priorRow()]);
    mocks.db = db; mocks.stripe = stripe.client;
    stripe.client.checkout.sessions.retrieve.mockRejectedValue(
      Object.assign(new Error("Stripe is down"), { type: "StripeAPIError", statusCode: 503 }),
    );

    const result = await checkout();

    expect(result).toMatchObject({ ok: false, status: 503 });
    expect(stripe.client.checkout.sessions.create).not.toHaveBeenCalled();
    expect(db.rows[0]!.stripe_checkout_session_id).toBe("cs_prior");
  });

  it("refuses when the confirming read after expire fails transiently, but not when it is gone", async () => {
    for (const [error, expected] of [
      [resourceMissing(), { ok: true }],
      [Object.assign(new Error("timeout"), { type: "StripeConnectionError" }), { ok: false, status: 503 }],
    ] as const) {
      const stripe = fakeStripe({ failExpire: true });
      const db = fakeDb([priorRow()]);
      mocks.db = db; mocks.stripe = stripe.client;
      seedPrior(stripe);
      let reads = 0;
      const real = stripe.client.checkout.sessions.retrieve.getMockImplementation()!;
      stripe.client.checkout.sessions.retrieve.mockImplementation(async (id: string) => {
        reads += 1;
        if (reads > 1) throw error;
        return real(id);
      });

      await expect(checkout()).resolves.toMatchObject(expected);
    }
  });
});
