import { afterEach, describe, expect, it, vi } from "vitest";
import { clearManagerPriceCache, resolveStripePriceIdForPaidTier } from "@/lib/stripe/resolve-manager-price";

const listPrices = vi.fn();
const listProducts = vi.fn();
const retrievePrice = vi.fn();
const retrieveProduct = vi.fn();

vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    prices: { list: listPrices, retrieve: retrievePrice },
    products: { list: listProducts, retrieve: retrieveProduct },
  }),
}));

describe("resolveStripePriceIdForPaidTier", () => {
  afterEach(() => {
    clearManagerPriceCache();
    listPrices.mockReset();
    listProducts.mockReset();
    retrievePrice.mockReset();
    retrieveProduct.mockReset();
    delete process.env.STRIPE_PRICE_PRO_MONTHLY;
    delete process.env.STRIPE_PRICE_PRO_ANNUAL;
  });

  it("uses env override when it is a price id", async () => {
    process.env.STRIPE_PRICE_PRO_MONTHLY = "price_env_pro_monthly";
    retrievePrice.mockResolvedValue({ id: "price_env_pro_monthly", active: true, currency: "usd", type: "recurring", unit_amount: 4900, recurring: { interval: "month", interval_count: 1 }, product: "prod_pro" });
    retrieveProduct.mockResolvedValue({ id: "prod_pro", metadata: { axis_plan: "axis_pro" } });
    await expect(resolveStripePriceIdForPaidTier("pro", "monthly")).resolves.toBe("price_env_pro_monthly");
    expect(listPrices).not.toHaveBeenCalled();
    expect(retrievePrice).toHaveBeenCalledWith("price_env_pro_monthly");
  });

  it("rejects an env price that would charge the wrong amount", async () => {
    process.env.STRIPE_PRICE_PRO_MONTHLY = "price_stale";
    retrievePrice.mockResolvedValue({ id: "price_stale", active: true, currency: "usd", type: "recurring", unit_amount: 2000, recurring: { interval: "month", interval_count: 1 }, product: "prod_pro" });
    await expect(resolveStripePriceIdForPaidTier("pro", "monthly")).rejects.toThrow("does not match the PropLane rate card");
    expect(listPrices).not.toHaveBeenCalled();
  });

  it.each([
    ["inactive", { active: false }],
    ["wrong currency", { currency: "eur" }],
    ["wrong interval", { recurring: { interval: "year", interval_count: 1 } }],
    ["wrong interval count", { recurring: { interval: "month", interval_count: 2 } }],
  ])("rejects an env price with %s", async (_label, override) => {
    process.env.STRIPE_PRICE_PRO_MONTHLY = "price_invalid";
    retrievePrice.mockResolvedValue({ id: "price_invalid", active: true, currency: "usd", type: "recurring", unit_amount: 4900, recurring: { interval: "month", interval_count: 1 }, product: "prod_pro", ...override });
    await expect(resolveStripePriceIdForPaidTier("pro", "monthly")).rejects.toThrow("does not match the PropLane rate card");
  });

  it("fails closed when Stripe cannot retrieve the configured price", async () => {
    process.env.STRIPE_PRICE_PRO_MONTHLY = "price_unreachable";
    retrievePrice.mockRejectedValue(new Error("Stripe unavailable"));
    await expect(resolveStripePriceIdForPaidTier("pro", "monthly")).rejects.toThrow("Stripe unavailable");
  });

  it("rejects a correct amount on the wrong tier product", async () => {
    process.env.STRIPE_PRICE_PRO_MONTHLY = "price_wrong_product";
    retrievePrice.mockResolvedValue({ id: "price_wrong_product", active: true, currency: "usd", type: "recurring", unit_amount: 4900, recurring: { interval: "month", interval_count: 1 }, product: "prod_other" });
    retrieveProduct.mockResolvedValue({ id: "prod_other", metadata: { axis_plan: "axis_business" } });
    await expect(resolveStripePriceIdForPaidTier("pro", "monthly")).rejects.toThrow("wrong product");
  });

  it("ignores numeric env values and resolves by lookup_key", async () => {
    process.env.STRIPE_PRICE_PRO_MONTHLY = "20";
    listPrices.mockResolvedValueOnce({ data: [{ id: "price_lookup_pro_monthly" }] });
    retrievePrice.mockResolvedValue({ id: "price_lookup_pro_monthly", active: true, currency: "usd", type: "recurring", unit_amount: 4900, recurring: { interval: "month", interval_count: 1 }, product: "prod_pro" });
    retrieveProduct.mockResolvedValue({ id: "prod_pro", metadata: { axis_plan: "axis_pro" } });
    await expect(resolveStripePriceIdForPaidTier("pro", "monthly")).resolves.toBe("price_lookup_pro_monthly");
    expect(listPrices).toHaveBeenCalledWith(
      expect.objectContaining({ lookup_keys: ["axis_manager_pro_monthly"] }),
    );
  });

  it("falls back to product metadata axis_plan", async () => {
    listPrices
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [{ id: "price_meta_pro_annual", unit_amount: 49000, recurring: { interval: "year" }, type: "recurring" }] });
    listProducts.mockResolvedValueOnce({ data: [{ id: "prod_pro", metadata: { axis_plan: "axis_pro" } }] });
    retrievePrice.mockResolvedValue({ id: "price_meta_pro_annual", active: true, currency: "usd", type: "recurring", unit_amount: 49000, recurring: { interval: "year", interval_count: 1 }, product: "prod_pro" });
    retrieveProduct.mockResolvedValue({ id: "prod_pro", metadata: { axis_plan: "axis_pro" } });

    await expect(resolveStripePriceIdForPaidTier("pro", "annual")).resolves.toBe("price_meta_pro_annual");
  });
});
