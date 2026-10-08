import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolvePrice: vi.fn(),
}));

vi.mock("@/lib/stripe", () => ({ getStripe: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn() }));
vi.mock("@/lib/stripe/resolve-manager-price", () => ({
  resolveStripePriceIdForManagerTier: mocks.resolvePrice,
}));

import type Stripe from "stripe";
import {
  buildPromoCouponParams,
  buildPromotionCodeParams,
  clearPromoPlanProductCache,
  createPromoCode,
  createPromoCodeSchema,
  expiresAtFromDateKey,
  projectPromoCode,
  setPromoCodeActive,
  setPromoCodeActiveSchema,
  summarizePromoUsage,
  type CreatePromoCodeInput,
} from "@/lib/admin/admin-promo-codes.server";
import { AdminInputError } from "@/lib/admin/admin-input-error";
import { describePromoDiscount, describePromoReview } from "@/lib/admin/promo-code-terms";
import { INTERNAL_WAIVER_PROMO_CODES, isInternalWaiverPromoCode, normalizePromoCodeInput } from "@/lib/stripe-promos";
import { BUILTIN_PAYMENT_WAIVER_CODE } from "@/lib/server-env";
import { LISTING_PAYMENT_WAIVER_CODE, LISTING_PROCESSING_FEE_PROMO_CODE } from "@/lib/processing-coverage-codes.server";

function parse(raw: Record<string, unknown>): CreatePromoCodeInput {
  return createPromoCodeSchema.parse({ code: "launch10", discountType: "percent", value: 10, ...raw });
}

function fakeStripe(overrides: { promoCreate?: ReturnType<typeof vi.fn>; existing?: Array<{ code: string }> } = {}) {
  const stripe = {
    promotionCodes: {
      list: vi.fn(async () => ({ data: overrides.existing ?? [] })),
      create: overrides.promoCreate ?? vi.fn(async (p: { code: string }) => ({ id: "promo_ABC1234", code: p.code })),
      update: vi.fn(async (id: string, p: { active: boolean }) => ({ id, active: p.active })),
    },
    coupons: {
      create: vi.fn(async () => ({ id: "cpn_1" })),
      del: vi.fn(async () => ({ id: "cpn_1", deleted: true })),
    },
    prices: {
      retrieve: vi.fn(async (id: string) => ({ id, product: id === "price_pro" ? "prod_pro" : "prod_business" })),
    },
  };
  return stripe;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPromoPlanProductCache();
  mocks.resolvePrice.mockImplementation(async (tier: string) => (tier === "pro" ? "price_pro" : "price_business"));
});

describe("create promo code validation", () => {
  it("uppercases and strips whitespace from the code", () => {
    expect(parse({ code: " launch 10 " }).code).toBe("LAUNCH10");
    expect(normalizePromoCodeInput("freefirst")).toBe("FREEFIRST");
  });

  it("refuses the internal waiver codes and malformed codes", () => {
    for (const code of ["free100", "WAIVEPROCESS1", "ab", "has$symbol", "x".repeat(40)]) {
      expect(createPromoCodeSchema.safeParse({ code, discountType: "percent", value: 10 }).success, code).toBe(false);
    }
  });

  it("pins the reserved list to the server waiver constants", () => {
    expect(INTERNAL_WAIVER_PROMO_CODES).toEqual(expect.arrayContaining([
      BUILTIN_PAYMENT_WAIVER_CODE,
      LISTING_PAYMENT_WAIVER_CODE,
      LISTING_PROCESSING_FEE_PROMO_CODE,
    ]));
    expect(isInternalWaiverPromoCode(" free100 ")).toBe(true);
    expect(isInternalWaiverPromoCode("FREEFIRST")).toBe(false);
  });

  it("bounds each discount type", () => {
    expect(createPromoCodeSchema.safeParse({ code: "OKCODE", discountType: "percent", value: 101 }).success).toBe(false);
    expect(createPromoCodeSchema.safeParse({ code: "OKCODE", discountType: "percent", value: 12.5 }).success).toBe(false);
    expect(createPromoCodeSchema.safeParse({ code: "OKCODE", discountType: "free_months", value: 0 }).success).toBe(false);
    expect(createPromoCodeSchema.safeParse({ code: "OKCODE", discountType: "free_months", value: 37 }).success).toBe(false);
    expect(createPromoCodeSchema.safeParse({ code: "OKCODE", discountType: "amount", value: 0.001 }).success).toBe(false);
    expect(createPromoCodeSchema.safeParse({ code: "OKCODE", discountType: "amount", value: 10_001 }).success).toBe(false);
    expect(createPromoCodeSchema.safeParse({ code: "OKCODE", discountType: "percent", value: 100 }).success).toBe(true);
  });

  it("needs a month count for a repeating duration and a future expiry", () => {
    expect(
      createPromoCodeSchema.safeParse({ code: "OKCODE", discountType: "percent", value: 10, duration: "repeating" }).success,
    ).toBe(false);
    expect(
      createPromoCodeSchema.safeParse({ code: "OKCODE", discountType: "percent", value: 10, expiresOn: "2020-01-01" }).success,
    ).toBe(false);
    expect(
      createPromoCodeSchema.safeParse({ code: "OKCODE", discountType: "percent", value: 10, expiresOn: "2999-01-01" }).success,
    ).toBe(true);
  });
});

describe("coupon and promotion code params", () => {
  it("percent off, once", () => {
    const params = buildPromoCouponParams(parse({ value: 20 }), []);
    expect(params).toMatchObject({ percent_off: 20, duration: "once" });
    expect(params).not.toHaveProperty("amount_off");
    expect(params).not.toHaveProperty("applies_to");
    expect(params.metadata).toMatchObject({ source: "proplane_admin", discount_type: "percent", plans: "all" });
  });

  it("percent off for N months", () => {
    expect(buildPromoCouponParams(parse({ value: 15, duration: "repeating", durationMonths: 3 }), [])).toMatchObject({
      percent_off: 15,
      duration: "repeating",
      duration_in_months: 3,
    });
  });

  it("amount off is dollars to cents in usd, forever", () => {
    const params = buildPromoCouponParams(parse({ discountType: "amount", value: 12.5, duration: "forever" }), []);
    expect(params).toMatchObject({ amount_off: 1250, currency: "usd", duration: "forever" });
    expect(params).not.toHaveProperty("percent_off");
    expect(params).not.toHaveProperty("duration_in_months");
  });

  it("one free month is 100% off once; N free months is 100% off for N months", () => {
    expect(buildPromoCouponParams(parse({ discountType: "free_months", value: 1 }), [])).toMatchObject({
      percent_off: 100,
      duration: "once",
    });
    const three = buildPromoCouponParams(parse({ discountType: "free_months", value: 3 }), []);
    expect(three).toMatchObject({ percent_off: 100, duration: "repeating", duration_in_months: 3 });
  });

  it("limits the coupon to the plan products and records the plans", () => {
    const params = buildPromoCouponParams(parse({ plans: ["pro"] }), ["prod_pro"]);
    expect(params.applies_to).toEqual({ products: ["prod_pro"] });
    expect(params.metadata).toMatchObject({ plans: "pro" });
  });

  it("promotion code carries the cap, expiry and first-time restriction", () => {
    const input = parse({ maxRedemptions: 50, firstTimeOnly: true, expiresOn: "2999-12-31" });
    const params = buildPromotionCodeParams(input, "cpn_1");
    expect(params).toMatchObject({
      promotion: { type: "coupon", coupon: "cpn_1" },
      code: "LAUNCH10",
      active: true,
      max_redemptions: 50,
      restrictions: { first_time_transaction: true },
    });
    expect(params.expires_at).toBe(expiresAtFromDateKey("2999-12-31"));
    expect(params.expires_at!).toBeGreaterThan(Date.UTC(2999, 11, 31) / 1000);
  });

  it("omits limits that were not set", () => {
    const params = buildPromotionCodeParams(parse({}), "cpn_1");
    expect(params).not.toHaveProperty("max_redemptions");
    expect(params).not.toHaveProperty("expires_at");
    expect(params).not.toHaveProperty("restrictions");
  });
});

describe("createPromoCode", () => {
  it("creates the coupon first, then the promotion code on it", async () => {
    const stripe = fakeStripe();
    const result = await createPromoCode(parse({ plans: ["pro", "business"] }), { stripe: stripe as unknown as Stripe });
    expect(result).toEqual({ id: "promo_ABC1234", code: "LAUNCH10", couponId: "cpn_1" });
    expect(stripe.coupons.create).toHaveBeenCalledWith(
      expect.objectContaining({ applies_to: { products: ["prod_pro", "prod_business"] } }),
    );
    expect(stripe.promotionCodes.create).toHaveBeenCalledWith(
      expect.objectContaining({ promotion: { type: "coupon", coupon: "cpn_1" }, code: "LAUNCH10" }),
    );
    expect(stripe.coupons.create.mock.invocationCallOrder[0]).toBeLessThan(stripe.promotionCodes.create.mock.invocationCallOrder[0]!);
  });

  it("refuses a code that already exists before creating anything", async () => {
    const stripe = fakeStripe({ existing: [{ code: "LAUNCH10" }] });
    await expect(createPromoCode(parse({}), { stripe: stripe as unknown as Stripe })).rejects.toMatchObject({
      status: 409,
    });
    expect(stripe.coupons.create).not.toHaveBeenCalled();
  });

  it("removes the coupon when the promotion code cannot be created", async () => {
    const promoCreate = vi.fn(async () => {
      throw Object.assign(new Error("stripe said no"), { code: "resource_already_exists" });
    });
    const stripe = fakeStripe({ promoCreate });
    const failure = createPromoCode(parse({}), { stripe: stripe as unknown as Stripe });
    await expect(failure).rejects.toBeInstanceOf(AdminInputError);
    expect(stripe.coupons.del).toHaveBeenCalledWith("cpn_1");
  });

  it("does not leak a Stripe error message for other failures", async () => {
    const promoCreate = vi.fn(async () => {
      throw new Error("req_secret123 invalid parameter");
    });
    const stripe = fakeStripe({ promoCreate });
    const error = await createPromoCode(parse({}), { stripe: stripe as unknown as Stripe }).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(AdminInputError);
    expect(stripe.coupons.del).toHaveBeenCalled();
  });
});

describe("deactivate", () => {
  it("turns the promotion code off", async () => {
    const stripe = fakeStripe();
    const result = await setPromoCodeActive("promo_ABC1234", false, { stripe: stripe as unknown as Stripe });
    expect(stripe.promotionCodes.update).toHaveBeenCalledWith("promo_ABC1234", { active: false });
    expect(result).toEqual({ id: "promo_ABC1234", active: false });
  });

  it("reports a code Stripe no longer has as 404", async () => {
    const stripe = fakeStripe();
    stripe.promotionCodes.update.mockRejectedValueOnce(Object.assign(new Error("No such"), { code: "resource_missing" }));
    await expect(setPromoCodeActive("promo_ABC1234", false, { stripe: stripe as unknown as Stripe })).rejects.toMatchObject({
      status: 404,
    });
  });

  it("validates the id before it reaches Stripe", () => {
    expect(setPromoCodeActiveSchema.safeParse({ id: "cus_123456" }).success).toBe(false);
    expect(setPromoCodeActiveSchema.safeParse({ id: "promo_ABC1234" })).toMatchObject({
      success: true,
      data: { active: false },
    });
  });
});

describe("usage and projection", () => {
  const invoice = (over: Partial<Stripe.Invoice> & { discountPromo: string | null; amount: number }) =>
    ({
      id: over.id ?? "in_1",
      status: over.status ?? "paid",
      created: over.created ?? 1_790_000_000,
      customer: over.customer ?? "cus_1",
      customer_email: over.customer_email ?? "a@example.com",
      customer_name: over.customer_name ?? "Ada",
      total_discount_amounts: over.discountPromo
        ? [{ amount: over.amount, discount: { id: "di_1", promotion_code: over.discountPromo } }]
        : [],
    }) as unknown as Stripe.Invoice;

  it("sums the discounts Stripe applied per code and groups redemptions by customer", () => {
    const usage = summarizePromoUsage([
      invoice({ id: "in_1", discountPromo: "promo_A", amount: 4900, created: 1_790_000_100 }),
      invoice({ id: "in_2", discountPromo: "promo_A", amount: 4900, created: 1_790_000_200 }),
      invoice({ id: "in_3", discountPromo: "promo_A", amount: 2000, customer: "cus_2", customer_email: "b@example.com" }),
      invoice({ id: "in_4", discountPromo: "promo_B", amount: 100 }),
      invoice({ id: "in_5", discountPromo: "promo_A", amount: 9999, status: "draft" }),
      invoice({ id: "in_6", discountPromo: "promo_A", amount: 9999, status: "void" }),
      invoice({ id: "in_7", discountPromo: null, amount: 0 }),
    ]);
    expect(usage.get("promo_A")!.givenCents).toBe(11_800);
    expect(usage.get("promo_B")!.givenCents).toBe(100);
    const a = usage.get("promo_A")!.redemptions;
    expect(a).toHaveLength(2);
    expect(a.find((r) => r.customerId === "cus_1")).toMatchObject({ invoices: 2, givenCents: 9800 });
  });

  const promo = (over: Record<string, unknown> = {}, coupon: Record<string, unknown> = {}) =>
    ({
      id: "promo_A",
      code: "FREEFIRST",
      active: true,
      created: 1_790_000_000,
      expires_at: null,
      max_redemptions: 50,
      times_redeemed: 9,
      restrictions: { first_time_transaction: false },
      promotion: {
        type: "coupon",
        coupon: { id: "cpn_1", name: "Free first month", valid: true, percent_off: 100, duration: "once", metadata: { plans: "pro" }, ...coupon },
      },
      ...over,
    }) as unknown as Stripe.PromotionCode;

  it("reads a 100%-off once coupon as one free month on Pro", () => {
    const row = projectPromoCode(promo(), { givenCents: 44_100, redemptions: [] }, {});
    expect(row).toMatchObject({
      code: "FREEFIRST",
      status: "active",
      discountType: "free_months",
      value: 1,
      summary: "1 month free",
      plans: ["pro"],
      timesRedeemed: 9,
      maxRedemptions: 50,
      givenCents: 44_100,
    });
  });

  it("reports active, expired and inactive", () => {
    const now = Date.parse("2026-10-08T00:00:00Z");
    expect(projectPromoCode(promo(), undefined, {}, now).status).toBe("active");
    expect(projectPromoCode(promo({ active: false }), undefined, {}, now).status).toBe("inactive");
    expect(projectPromoCode(promo({ expires_at: Math.floor(now / 1000) - 60, active: false }), undefined, {}, now).status).toBe("expired");
    expect(projectPromoCode(promo({ times_redeemed: 50 }), undefined, {}, now).status).toBe("expired");
    expect(projectPromoCode(promo({}, { valid: false }), undefined, {}, now).status).toBe("expired");
  });

  it("falls back to the coupon's products when it has no plan metadata", () => {
    const row = projectPromoCode(
      promo({}, { metadata: {}, applies_to: { products: ["prod_business"] } }),
      undefined,
      { pro: "prod_pro", business: "prod_business" },
    );
    expect(row.plans).toEqual(["business"]);
  });

  it("describes terms in one sentence", () => {
    expect(describePromoDiscount({ discountType: "percent", value: 20, duration: "repeating", durationMonths: 3 })).toBe("20% off for 3 months");
    expect(describePromoDiscount({ discountType: "amount", value: 25, duration: "once" })).toBe("$25 off once");
    expect(describePromoDiscount({ discountType: "free_months", value: 2, duration: "once" })).toBe("2 months free");
    expect(
      describePromoReview({ code: "FREEFIRST", discountType: "free_months", value: 1, duration: "once", plans: ["pro"], maxRedemptions: 50, expiresOn: "2026-12-31" }),
    ).toBe("FREEFIRST: 1 month free on Pro, 50 uses, expires Dec 31, 2026");
  });
});
