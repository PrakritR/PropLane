import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkoutCreate: vi.fn(),
  priceRetrieve: vi.fn(),
  productRetrieve: vi.fn(),
  classification: vi.fn(),
  serviceDb: vi.fn(),
  sessionRetrieve: vi.fn(),
  promoRetrieve: vi.fn(),
}));

vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: mocks.serviceDb }));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    checkout: { sessions: { create: mocks.checkoutCreate, retrieve: mocks.sessionRetrieve } },
    prices: { retrieve: mocks.priceRetrieve },
    products: { retrieve: mocks.productRetrieve },
    promotionCodes: { retrieve: mocks.promoRetrieve },
  }),
}));
vi.mock("@/lib/test-workspaces/index.server", () => ({ resolveTestWorkspaceClassification: mocks.classification }));

import type Stripe from "stripe";
import { createManagerCheckoutSession } from "@/lib/stripe/manager-checkout";
import { buildManagerSubscriptionCheckoutBase } from "@/lib/stripe/subscription-checkout-session";
import { resolveCheckoutSessionPromoCode } from "@/lib/stripe/checkout-promo-code.server";
import { clearManagerPriceCache } from "@/lib/stripe/resolve-manager-price";
import { RATE_CARD } from "@/lib/billing/rate-card";

function checkoutDb() {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    not: vi.fn(() => query),
    limit: vi.fn(() => query),
    maybeSingle: vi.fn(async () => ({ data: null, error: null })),
    upsert: vi.fn(async () => ({ error: null })),
    in: vi.fn(async () => ({ data: [], error: null })),
  };
  return { from: vi.fn(() => query), query };
}

const PLANS = [
  { tier: "pro", billing: "monthly", env: "STRIPE_PRICE_PRO_MONTHLY", cents: RATE_CARD.pro.floorMonthlyCents, plan: "axis_pro" },
  { tier: "pro", billing: "annual", env: "STRIPE_PRICE_PRO_ANNUAL", cents: RATE_CARD.pro.floorAnnualCents, plan: "axis_pro" },
  { tier: "business", billing: "monthly", env: "STRIPE_PRICE_BUSINESS_MONTHLY", cents: RATE_CARD.business.floorMonthlyCents, plan: "axis_business" },
  { tier: "business", billing: "annual", env: "STRIPE_PRICE_BUSINESS_ANNUAL", cents: RATE_CARD.business.floorAnnualCents, plan: "axis_business" },
] as const;

describe("promotion codes at manager checkout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearManagerPriceCache();
    delete process.env.STRIPE_PROMOTION_CODE_ID_FIRST_MONTH_FREE;
    mocks.classification.mockResolvedValue({ kind: "normal" });
    mocks.serviceDb.mockReturnValue(checkoutDb());
    mocks.checkoutCreate.mockResolvedValue({ id: "cs_1", client_secret: "secret" });
  });

  function arrangePlan(plan: (typeof PLANS)[number]) {
    for (const p of PLANS) delete process.env[p.env];
    process.env[plan.env] = `price_${plan.tier}_${plan.billing}`;
    mocks.priceRetrieve.mockResolvedValue({
      id: `price_${plan.tier}_${plan.billing}`,
      active: true,
      currency: "usd",
      type: "recurring",
      unit_amount: plan.cents,
      recurring: { interval: plan.billing === "annual" ? "year" : "month", interval_count: 1 },
      product: "prod_x",
    });
    mocks.productRetrieve.mockResolvedValue({ id: "prod_x", metadata: { axis_plan: plan.plan } });
  }

  it.each(PLANS)("shows the promotion code field on $tier $billing", async (plan) => {
    arrangePlan(plan);
    const result = await createManagerCheckoutSession({
      tier: plan.tier,
      billing: plan.billing,
      email: "manager@example.com",
      userId: "owner-1",
      req: new Request("http://localhost/partner/pricing"),
    });
    expect(result.ok).toBe(true);
    expect(mocks.checkoutCreate).toHaveBeenCalledWith(expect.objectContaining({ allow_promotion_codes: true }));
    expect(mocks.checkoutCreate.mock.calls[0]![0]).not.toHaveProperty("discounts");
  });

  it("keeps FREEFIRST as an applied discount (Stripe refuses discounts together with the field)", async () => {
    process.env.STRIPE_PROMOTION_CODE_ID_FIRST_MONTH_FREE = "promo_firstmonthfree";
    arrangePlan(PLANS[0]);
    const result = await createManagerCheckoutSession({
      tier: "pro",
      billing: "monthly",
      email: "manager@example.com",
      userId: "owner-1",
      promo: "firstfree",
      req: new Request("http://localhost/partner/pricing"),
    });
    expect(result.ok).toBe(true);
    const params = mocks.checkoutCreate.mock.calls[0]![0];
    expect(params.discounts).toEqual([{ promotion_code: "promo_firstmonthfree" }]);
    expect(params).not.toHaveProperty("allow_promotion_codes");
  });

  it("still refuses FREEFIRST on a plan other than Pro monthly", async () => {
    arrangePlan(PLANS[3]);
    const result = await createManagerCheckoutSession({
      tier: "business",
      billing: "annual",
      email: "manager@example.com",
      promo: "FREEFIRST",
      req: new Request("http://localhost/partner/pricing"),
    });
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(mocks.checkoutCreate).not.toHaveBeenCalled();
  });
});

describe("subscription checkout base", () => {
  const base = { priceId: "price_x", metadata: { tier: "pro" } };

  it("allows promotion codes by default, on every plan", () => {
    expect(buildManagerSubscriptionCheckoutBase(base)).toMatchObject({ allow_promotion_codes: true });
  });

  it("can hide the field, and never sends it beside an applied discount", () => {
    expect(buildManagerSubscriptionCheckoutBase({ ...base, allowPromotionCodes: false })).not.toHaveProperty("allow_promotion_codes");
    const withDiscount = buildManagerSubscriptionCheckoutBase({ ...base, discounts: [{ promotion_code: "promo_1" }] });
    expect(withDiscount).not.toHaveProperty("allow_promotion_codes");
    expect(withDiscount.discounts).toEqual([{ promotion_code: "promo_1" }]);
  });
});

describe("recording the redeemed code", () => {
  const session = (over: Record<string, unknown>) => ({ id: "cs_1", metadata: {}, ...over }) as unknown as Stripe.Checkout.Session;

  beforeEach(() => vi.clearAllMocks());

  it("prefers the code typed on the pricing form", async () => {
    expect(await resolveCheckoutSessionPromoCode(session({ metadata: { promo: "freefirst" } }))).toBe("FREEFIRST");
    expect(mocks.sessionRetrieve).not.toHaveBeenCalled();
  });

  it("reads a code typed into Checkout's own field from the session discounts", async () => {
    mocks.promoRetrieve.mockResolvedValue({ id: "promo_1", code: "launch10" });
    const code = await resolveCheckoutSessionPromoCode(session({ discounts: [{ coupon: "cpn_1", promotion_code: "promo_1" }] }));
    expect(code).toBe("LAUNCH10");
  });

  it("uses an expanded promotion code without another call", async () => {
    const code = await resolveCheckoutSessionPromoCode(
      session({ discounts: [{ coupon: null, promotion_code: { id: "promo_1", code: "SAVE5" } }] }),
    );
    expect(code).toBe("SAVE5");
    expect(mocks.promoRetrieve).not.toHaveBeenCalled();
  });

  it("re-reads the session when the event payload carries no discounts", async () => {
    mocks.sessionRetrieve.mockResolvedValue({ discounts: [{ promotion_code: { id: "promo_1", code: "BACK2" } }] });
    expect(await resolveCheckoutSessionPromoCode(session({}))).toBe("BACK2");
    expect(mocks.sessionRetrieve).toHaveBeenCalledWith("cs_1", { expand: ["discounts.promotion_code"] });
  });

  it("records nothing when no code was used, and never throws on a Stripe failure", async () => {
    expect(await resolveCheckoutSessionPromoCode(session({ discounts: [] }))).toBeNull();
    mocks.sessionRetrieve.mockRejectedValue(new Error("stripe down"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await resolveCheckoutSessionPromoCode(session({}))).toBeNull();
    errors.mockRestore();
  });
});
