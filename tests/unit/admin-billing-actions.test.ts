/**
 * The three LIVE staff billing actions: extend trial, complimentary on/off, apply promo code.
 *
 * What these pin, in order of what they cost when wrong:
 *
 * 1. **They act.** These used to be "recorded only" switches. Extending a trial must move the date
 *    the plan resolver READS (the Stripe `trial_end`, or the signup trial's `paid_at`), and
 *    complimentary must put a 100%-off-forever coupon on the subscription - proven here against the
 *    real resolver, not against a stored flag.
 * 2. **A reason is required, and is refused before any side effect.** Stripe is never called, and
 *    nothing is written, without one.
 * 3. **One audit row per change** (actor, field, before, after, reason), and none for a no-op.
 *
 * Stripe is mocked; the database is an in-memory double.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
let tables: Record<string, Row[]> = {};
let purchaseReadError: { message: string } | null = null;

/** Thenable builder: select/update/upsert/insert over arrays, with `eq` filters. */
function makeDb() {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let patch: Row | null = null;
      const run = () => {
        const rows = (tables[table] ??= []);
        const matching = rows.filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v));
        if (patch) {
          for (const r of matching) Object.assign(r, patch);
          return { data: null, error: null };
        }
        if (purchaseReadError && table === "manager_purchases") return { data: null, error: purchaseReadError };
        return { data: matching, error: null };
      };
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (col: string, value: unknown) => {
          filters[col] = value;
          return q;
        },
        update: (values: Row) => {
          patch = values;
          return q;
        },
        maybeSingle: async () => ({ data: (run().data as Row[] | null)?.[0] ?? null, error: null }),
        upsert: async (values: Row) => {
          const rows = (tables[table] ??= []);
          const idx = rows.findIndex((r) => r.manager_user_id === values.manager_user_id);
          if (idx >= 0) rows[idx] = { ...rows[idx], ...values };
          else rows.push({ ...values });
          return { error: null };
        },
        insert: async (values: Row) => {
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

const stripe = {
  subscriptions: { retrieve: vi.fn(), update: vi.fn() },
  promotionCodes: { list: vi.fn(), retrieve: vi.fn() },
  coupons: { retrieve: vi.fn(), create: vi.fn() },
};
const assertTestWorkspace = vi.fn();
const reconcile = vi.fn();

vi.mock("@/lib/stripe", () => ({ getStripe: () => stripe, isStripeLiveMode: () => false }));
vi.mock("@/lib/test-workspaces/effects.server", () => ({
  assertTestWorkspaceProviderEffectAllowed: (...a: unknown[]) => assertTestWorkspace(...a),
}));
vi.mock("@/lib/manager-stripe-subscription-sync", () => ({
  reconcileManagerPurchaseByStripeSubscriptionId: (...a: unknown[]) => reconcile(...a),
}));

const {
  COMPLIMENTARY_COUPON_ID,
  applyAccountPromoCode,
  extendAccountTrial,
  setAccountComplimentary,
} = await import("@/lib/admin/admin-billing-actions.server");
const { resolveEffectiveManagerSkuTier } = await import("@/lib/manager-access");
const { managerPurchasePeriodEndMs } = await import("@/lib/manager-tier-expiry");

const MANAGER = "mgr-1";
const ACTOR = "admin-1";
const NOW = Date.parse("2026-10-08T12:00:00.000Z");
const SUB = "sub_123";

const ctx = (reason: unknown = "Pilot customer asked for more time") => ({
  db: makeDb() as never,
  actorUserId: ACTOR,
  managerUserId: MANAGER,
  reason,
});

const stripePurchase = (): Row => ({
  id: "p1",
  user_id: MANAGER,
  tier: "pro",
  billing: "monthly",
  paid_at: "2026-09-01T00:00:00.000Z",
  stripe_subscription_id: SUB,
  stripe_customer_id: "cus_1",
});
const trialPurchase = (): Row => ({
  id: "p2",
  user_id: MANAGER,
  tier: "pro",
  billing: "trial",
  paid_at: "2026-10-01T00:00:00.000Z",
  stripe_subscription_id: null,
});

const subscription = (over: Record<string, unknown> = {}) => ({
  id: SUB,
  status: "trialing",
  trial_end: Math.floor(Date.parse("2026-10-15T00:00:00.000Z") / 1000),
  discounts: [] as unknown[],
  ...over,
});

const auditRows = () => tables.audit_log ?? [];
const auditSummary = (i = 0) => auditRows()[i]?.input_summary as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  tables = {};
  purchaseReadError = null;
  assertTestWorkspace.mockResolvedValue(undefined);
  reconcile.mockResolvedValue(undefined);
  stripe.subscriptions.retrieve.mockResolvedValue(subscription());
  stripe.subscriptions.update.mockResolvedValue({});
  stripe.coupons.retrieve.mockResolvedValue({ id: COMPLIMENTARY_COUPON_ID });
  stripe.promotionCodes.list.mockResolvedValue({ data: [{ id: "promo_1", code: "FREEFIRST" }] });
  stripe.promotionCodes.retrieve.mockResolvedValue({ id: "promo_x", code: "OLDCODE" });
});

describe("a reason is required, before anything happens", () => {
  it.each([
    ["extend trial", () => extendAccountTrial(ctx(""), "2026-11-01", NOW)],
    ["complimentary", () => setAccountComplimentary(ctx("   "), true)],
    ["promo code", () => applyAccountPromoCode(ctx(null), "FREEFIRST")],
  ])("%s refuses a missing reason with no Stripe call, no write and no audit row", async (_name, call) => {
    tables.manager_purchases = [stripePurchase()];
    const result = await call();
    expect(result).toMatchObject({ ok: false, status: 400, error: "A reason is required." });
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(stripe.promotionCodes.list).not.toHaveBeenCalled();
    expect(auditRows()).toHaveLength(0);
  });
});

describe("extend trial", () => {
  it("sets the Stripe subscription's trial_end and audits before -> after", async () => {
    tables.manager_purchases = [stripePurchase()];
    const result = await extendAccountTrial(ctx(), "2026-11-01", NOW);
    expect(result).toMatchObject({ ok: true, via: "stripe", trialEndsAt: "2026-11-01", auditRecorded: true });
    expect(stripe.subscriptions.update).toHaveBeenCalledWith(SUB, {
      trial_end: Math.floor(Date.parse("2026-11-01T23:59:59.000Z") / 1000),
      proration_behavior: "none",
    });
    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0]).toMatchObject({
      actor_user_id: ACTOR,
      landlord_id: MANAGER,
      action: "admin_billing_override",
      input_summary: {
        field: "trialEndsAt",
        before: "2026-10-15",
        after: "2026-11-01",
        reason: "Pilot customer asked for more time",
      },
    });
  });

  it("moves the date the RESOLVER reads when the trial has no card (no Stripe subscription)", async () => {
    tables.manager_purchases = [trialPurchase()];
    const result = await extendAccountTrial(ctx(), "2026-12-24", NOW);
    expect(result).toMatchObject({ ok: true, via: "account", trialEndsAt: "2026-12-24" });
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();

    const row = tables.manager_purchases![0]!;
    const resolve = (nowMs: number) =>
      resolveEffectiveManagerSkuTier({
        tier: row.tier as string,
        billing: row.billing as string,
        paidAt: row.paid_at as string,
        stripeSubscriptionId: null,
        nowMs,
      });
    // Live all of Dec 24, Free from Dec 25: the same derivation the property cap and nav locks use.
    expect(resolve(Date.parse("2026-12-24T20:00:00.000Z"))).toBe("pro");
    expect(resolve(Date.parse("2026-12-25T00:00:01.000Z"))).toBe("free");
    expect(new Date(managerPurchasePeriodEndMs(row as never)!).toISOString().slice(0, 10)).toBe("2026-12-24");
    expect(auditSummary()).toMatchObject({ field: "trialEndsAt", before: "2026-10-15", after: "2026-12-24" });
  });

  it("clears a trial date older builds merely recorded", async () => {
    tables.manager_purchases = [trialPurchase()];
    tables.manager_automation_settings = [
      { manager_user_id: MANAGER, row_data: { billingOverrides: { propertyCap: 4, trialEndsAt: "2026-11-30" } } },
    ];
    await extendAccountTrial(ctx(), "2026-12-24", NOW);
    const stored = (tables.manager_automation_settings![0]!.row_data as Row).billingOverrides;
    expect(stored).toEqual({ propertyCap: 4, trialEndsAt: null, complimentary: false });
  });

  it("refuses a date in the past, a non-date and a date beyond Stripe's two years", async () => {
    tables.manager_purchases = [stripePurchase()];
    expect(await extendAccountTrial(ctx(), "2026-10-01", NOW)).toMatchObject({ ok: false, status: 400 });
    expect(await extendAccountTrial(ctx(), "next week", NOW)).toMatchObject({ ok: false, status: 400 });
    expect(await extendAccountTrial(ctx(), "2026-02-31", NOW)).toMatchObject({ ok: false, status: 400 });
    expect(await extendAccountTrial(ctx(), "2029-01-01", NOW)).toMatchObject({ ok: false, status: 400 });
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(auditRows()).toHaveLength(0);
  });

  it("refuses an account with no trial to extend, and a canceled subscription", async () => {
    tables.manager_purchases = [{ ...trialPurchase(), billing: "monthly" }];
    expect(await extendAccountTrial(ctx(), "2026-12-24", NOW)).toMatchObject({ ok: false, status: 409 });

    tables.manager_purchases = [stripePurchase()];
    stripe.subscriptions.retrieve.mockResolvedValue(subscription({ status: "canceled" }));
    expect(await extendAccountTrial(ctx(), "2026-12-24", NOW)).toMatchObject({ ok: false, status: 409 });
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(auditRows()).toHaveLength(0);
  });

  it("reports a Stripe failure without its message, and writes no audit row for it", async () => {
    tables.manager_purchases = [stripePurchase()];
    stripe.subscriptions.update.mockRejectedValue(new Error("No such subscription: sub_secret_detail"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await extendAccountTrial(ctx(), "2026-11-01", NOW);
    spy.mockRestore();
    expect(result).toMatchObject({ ok: false, status: 502, error: "Stripe could not apply that change. Try again." });
    expect(JSON.stringify(result)).not.toContain("sub_secret_detail");
    expect(auditRows()).toHaveLength(0);
  });

  it("never reaches Stripe for a test workspace", async () => {
    tables.manager_purchases = [stripePurchase()];
    assertTestWorkspace.mockRejectedValue(new Error("test workspace"));
    expect(await extendAccountTrial(ctx(), "2026-11-01", NOW)).toMatchObject({ ok: false, status: 409 });
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it("does not report a purchase it could not read as 'no trial'", async () => {
    purchaseReadError = { message: "boom" };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await extendAccountTrial(ctx(), "2026-11-01", NOW);
    spy.mockRestore();
    expect(result).toMatchObject({ ok: false, status: 500 });
    expect(auditRows()).toHaveLength(0);
  });
});

describe("complimentary", () => {
  it("ON with a subscription: creates the coupon if missing and attaches it beside existing discounts", async () => {
    tables.manager_purchases = [stripePurchase()];
    stripe.subscriptions.retrieve.mockResolvedValue(
      subscription({ discounts: [{ id: "di_promo", source: { type: "coupon", coupon: "c_first" }, promotion_code: "promo_1" }] }),
    );
    stripe.coupons.retrieve.mockRejectedValue(Object.assign(new Error("missing"), { code: "resource_missing" }));
    const result = await setAccountComplimentary(ctx(), true);
    expect(result).toMatchObject({ ok: true, complimentary: true, changed: true });
    expect(stripe.coupons.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: COMPLIMENTARY_COUPON_ID, percent_off: 100, duration: "forever" }),
    );
    expect(stripe.subscriptions.update).toHaveBeenCalledWith(SUB, {
      discounts: [{ discount: "di_promo" }, { coupon: COMPLIMENTARY_COUPON_ID }],
    });
    expect(auditSummary()).toMatchObject({ field: "complimentary", before: false, after: true });
    const stored = (tables.manager_automation_settings![0]!.row_data as Row).billingOverrides;
    expect(stored).toMatchObject({ complimentary: true });
  });

  it("OFF with a subscription: removes only the comp discount (Undo)", async () => {
    tables.manager_purchases = [stripePurchase()];
    stripe.subscriptions.retrieve.mockResolvedValue(
      subscription({
        discounts: [
          { id: "di_promo", source: { type: "coupon", coupon: "c_first" } },
          { id: "di_comp", source: { type: "coupon", coupon: { id: COMPLIMENTARY_COUPON_ID } } },
        ],
      }),
    );
    const result = await setAccountComplimentary(ctx(), false);
    expect(result).toMatchObject({ ok: true, complimentary: false, changed: true });
    expect(stripe.subscriptions.update).toHaveBeenCalledWith(SUB, { discounts: [{ discount: "di_promo" }] });
    expect(auditSummary()).toMatchObject({ field: "complimentary", before: true, after: false });
  });

  it("OFF when it was the only discount empties the list the way Stripe expects", async () => {
    tables.manager_purchases = [stripePurchase()];
    stripe.subscriptions.retrieve.mockResolvedValue(
      subscription({ discounts: [{ id: "di_comp", source: { type: "coupon", coupon: COMPLIMENTARY_COUPON_ID } }] }),
    );
    await setAccountComplimentary(ctx(), false);
    expect(stripe.subscriptions.update).toHaveBeenCalledWith(SUB, { discounts: "" });
  });

  it("is a no-op, with no Stripe write and no audit row, when already in the asked state", async () => {
    tables.manager_purchases = [stripePurchase()];
    const result = await setAccountComplimentary(ctx(), false);
    expect(result).toMatchObject({ ok: true, changed: false });
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(auditRows()).toHaveLength(0);
  });

  it("without a subscription: ON makes the plan an admin grant that never lapses, OFF puts the trial back", async () => {
    tables.manager_purchases = [trialPurchase()];
    const on = await setAccountComplimentary(ctx(), true);
    expect(on).toMatchObject({ ok: true, complimentary: true });
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
    const row = tables.manager_purchases![0]!;
    expect(row.billing).toBe("admin");
    // An admin grant is not date-expired, so a trial that would have lapsed no longer does.
    expect(
      resolveEffectiveManagerSkuTier({
        tier: "pro",
        billing: "admin",
        paidAt: row.paid_at as string,
        stripeSubscriptionId: null,
        nowMs: Date.parse("2027-06-01T00:00:00.000Z"),
      }),
    ).toBe("pro");

    const off = await setAccountComplimentary(ctx(), false);
    expect(off).toMatchObject({ ok: true, complimentary: false });
    expect(row.billing).toBe("trial");
    expect(row.paid_at).toBe("2026-10-01T00:00:00.000Z");
    expect(auditRows().map((r) => (r.input_summary as Row).after)).toEqual([true, false]);
  });

  it("refuses to comp a free account and an App Store subscription", async () => {
    tables.manager_purchases = [{ ...trialPurchase(), tier: "free", billing: "free" }];
    expect(await setAccountComplimentary(ctx(), true)).toMatchObject({ ok: false, status: 409 });
    tables.manager_purchases = [
      { ...trialPurchase(), billing: "apple", apple_original_transaction_id: "tx_1" },
    ];
    expect(await setAccountComplimentary(ctx(), true)).toMatchObject({ ok: false, status: 409 });
    expect(auditRows()).toHaveLength(0);
  });

  it("refuses a non-boolean", async () => {
    tables.manager_purchases = [stripePurchase()];
    expect(await setAccountComplimentary(ctx(), "yes")).toMatchObject({ ok: false, status: 400 });
  });
});

describe("apply promo code", () => {
  it("attaches an existing promotion code beside the discounts already there, and audits it", async () => {
    tables.manager_purchases = [stripePurchase()];
    stripe.subscriptions.retrieve.mockResolvedValue(
      subscription({ discounts: [{ id: "di_old", source: { type: "coupon", coupon: "c_old" }, promotion_code: "promo_x" }] }),
    );
    const result = await applyAccountPromoCode(ctx(), "freefirst");
    expect(result).toMatchObject({ ok: true, promoCode: "FREEFIRST", auditRecorded: true });
    expect(stripe.promotionCodes.list).toHaveBeenCalledWith({ code: "freefirst", active: true, limit: 1 });
    expect(stripe.subscriptions.update).toHaveBeenCalledWith(SUB, {
      discounts: [{ discount: "di_old" }, { promotion_code: "promo_1" }],
    });
    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0]).toMatchObject({
      actor_user_id: ACTOR,
      landlord_id: MANAGER,
      input_summary: {
        field: "promoCode",
        before: "OLDCODE",
        after: "FREEFIRST",
        reason: "Pilot customer asked for more time",
      },
    });
  });

  it("never creates a code: an unknown or inactive one is a 404 and changes nothing", async () => {
    tables.manager_purchases = [stripePurchase()];
    stripe.promotionCodes.list.mockResolvedValue({ data: [] });
    expect(await applyAccountPromoCode(ctx(), "NOPE")).toMatchObject({ ok: false, status: 404 });
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(auditRows()).toHaveLength(0);
  });

  it("refuses a code already on the subscription", async () => {
    tables.manager_purchases = [stripePurchase()];
    stripe.subscriptions.retrieve.mockResolvedValue(
      subscription({ discounts: [{ id: "di_1", source: { type: "coupon", coupon: "c" }, promotion_code: "promo_1" }] }),
    );
    expect(await applyAccountPromoCode(ctx(), "FREEFIRST")).toMatchObject({ ok: false, status: 409 });
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it("needs a Stripe subscription - an admin or App Store plan has no invoice to discount", async () => {
    tables.manager_purchases = [trialPurchase()];
    expect(await applyAccountPromoCode(ctx(), "FREEFIRST")).toMatchObject({ ok: false, status: 409 });
    expect(stripe.promotionCodes.list).not.toHaveBeenCalled();
  });

  it.each(["", "has space", "semi;colon", "x".repeat(65)])("refuses the malformed code %j", async (code) => {
    tables.manager_purchases = [stripePurchase()];
    expect(await applyAccountPromoCode(ctx(), code)).toMatchObject({ ok: false, status: 400 });
    expect(stripe.promotionCodes.list).not.toHaveBeenCalled();
  });
});

describe("the audit trail", () => {
  it("reports a failed audit insert instead of claiming the change was recorded", async () => {
    tables.manager_purchases = [stripePurchase()];
    const db = makeDb() as unknown as { from: (t: string) => Record<string, unknown> };
    const failing = {
      from(table: string) {
        const q = db.from(table);
        if (table === "audit_log") q.insert = async () => ({ error: { message: "audit down" } });
        return q;
      },
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await extendAccountTrial({ ...ctx(), db: failing as never }, "2026-11-01", NOW);
    spy.mockRestore();
    // The write landed - losing the response over the trail would be worse than a gap in it.
    expect(result).toMatchObject({ ok: true, auditRecorded: false });
    expect(stripe.subscriptions.update).toHaveBeenCalled();
  });
});
