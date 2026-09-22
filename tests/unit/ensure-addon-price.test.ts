import { beforeEach, describe, expect, it, vi } from "vitest";

// `ensureAddonPrice` is what makes add-ons always purchasable (PLAN-0920): env
// override first, then an existing Price under the add-on's stable
// `lookup_key`, then create the Product + Price. Each addonId/tier pair below
// is unique to the test that exercises it so the module-level cache never
// leaks a result from one test into another's assertions.

import { ensureAddonPrice } from "@/lib/plan-addons.server";
import { planAddonLookupKey } from "@/lib/plan-addons";

beforeEach(() => {
  vi.unstubAllEnvs();
});

describe("ensureAddonPrice", () => {
  it("returns the env-configured Price without reading or creating anything", async () => {
    vi.stubEnv("STRIPE_PRICE_ADDON_EXTRA_SEAT_PRO", "price_env_seat_pro");
    const prices = { list: vi.fn(), create: vi.fn() };
    const products = { create: vi.fn() };

    const priceId = await ensureAddonPrice({ prices, products } as never, "extra_seat", "pro");

    expect(priceId).toBe("price_env_seat_pro");
    expect(prices.list).not.toHaveBeenCalled();
    expect(prices.create).not.toHaveBeenCalled();
    expect(products.create).not.toHaveBeenCalled();
  });

  it("finds an existing Price by lookup_key and never creates a duplicate", async () => {
    const lookupKey = planAddonLookupKey("extra_workspace", "business");
    const prices = {
      list: vi.fn().mockResolvedValue({ data: [{ id: "price_existing_workspace_biz" }] }),
      create: vi.fn(),
    };
    const products = { create: vi.fn() };

    const priceId = await ensureAddonPrice({ prices, products } as never, "extra_workspace", "business");

    expect(priceId).toBe("price_existing_workspace_biz");
    expect(prices.list).toHaveBeenCalledWith(expect.objectContaining({ lookup_keys: [lookupKey], active: true }));
    expect(prices.create).not.toHaveBeenCalled();
    expect(products.create).not.toHaveBeenCalled();
  });

  it("creates the Product and Price once, then reuses the in-process cache", async () => {
    const lookupKey = planAddonLookupKey("extra_work_number", "pro");
    const prices = {
      list: vi.fn().mockResolvedValue({ data: [] }),
      create: vi.fn().mockResolvedValue({ id: "price_created_number_pro" }),
    };
    const products = { create: vi.fn().mockResolvedValue({ id: lookupKey }) };

    const first = await ensureAddonPrice({ prices, products } as never, "extra_work_number", "pro");
    const second = await ensureAddonPrice({ prices, products } as never, "extra_work_number", "pro");

    expect(first).toBe("price_created_number_pro");
    expect(second).toBe("price_created_number_pro");
    expect(products.create).toHaveBeenCalledTimes(1);
    expect(products.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: lookupKey, metadata: { plan_addon_id: "extra_work_number" } }),
    );
    expect(prices.create).toHaveBeenCalledTimes(1);
    expect(prices.create).toHaveBeenCalledWith(
      expect.objectContaining({ lookup_key: lookupKey, recurring: { interval: "month" }, currency: "usd" }),
    );
    // The second call is served from the cache: `list` still ran once, from the first call's miss.
    expect(prices.list).toHaveBeenCalledTimes(1);
  });

  it("uses the Price another process just created when this one loses the lookup_key race", async () => {
    const lookupKey = planAddonLookupKey("extra_seat", "business");
    const raceError = Object.assign(new Error("already exists"), { code: "resource_already_exists" });
    const prices = {
      list: vi
        .fn()
        .mockResolvedValueOnce({ data: [] })
        .mockResolvedValueOnce({ data: [{ id: "price_won_the_race" }] }),
      create: vi.fn().mockRejectedValue(raceError),
    };
    const products = { create: vi.fn().mockResolvedValue({ id: lookupKey }) };

    const priceId = await ensureAddonPrice({ prices, products } as never, "extra_seat", "business");

    expect(priceId).toBe("price_won_the_race");
    expect(prices.list).toHaveBeenCalledTimes(2);
  });
});
