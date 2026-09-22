import { describe, expect, it } from "vitest";
import {
  RATE_CARD,
  RATE_CARD_TIERS,
  RATE_CARD_VERSION,
  annualDiscountPercent,
  formatRateCardUsd,
  priceForDoors,
} from "@/lib/billing/rate-card";

describe("RATE_CARD shape", () => {
  it("has a non-empty version identifier", () => {
    expect(RATE_CARD_VERSION).toBeTruthy();
    expect(typeof RATE_CARD_VERSION).toBe("string");
  });

  it("gives every tier a complete price shape", () => {
    for (const tier of RATE_CARD_TIERS) {
      const card = RATE_CARD[tier];
      expect(card.floorMonthlyCents, `${tier} floorMonthlyCents`).toBeGreaterThanOrEqual(0);
      expect(card.floorAnnualCents, `${tier} floorAnnualCents`).toBeGreaterThanOrEqual(0);
      expect(card.includedDoors, `${tier} includedDoors`).toBeGreaterThan(0);
      expect(card.commsIncludedAllowanceCents, `${tier} commsIncludedAllowanceCents`).toBeGreaterThanOrEqual(0);
    }
  });

  it("prices the approved rate card (Option A)", () => {
    expect(RATE_CARD.free).toMatchObject({
      floorMonthlyCents: 0,
      floorAnnualCents: 0,
      includedDoors: 2,
      perExtraDoorMonthlyCents: null,
      commsIncludedAllowanceCents: 0,
    });
    expect(RATE_CARD.pro).toMatchObject({
      floorMonthlyCents: 4_900,
      floorAnnualCents: 49_000,
      includedDoors: 20,
      perExtraDoorMonthlyCents: 300,
      commsIncludedAllowanceCents: 2_500,
    });
    expect(RATE_CARD.business).toMatchObject({
      floorMonthlyCents: 24_900,
      floorAnnualCents: 249_000,
      includedDoors: 120,
      perExtraDoorMonthlyCents: 200,
      commsIncludedAllowanceCents: 15_000,
    });
  });

  it("strictly increases floor and included doors from Free to Pro to Business", () => {
    expect(RATE_CARD.free.floorMonthlyCents).toBeLessThan(RATE_CARD.pro.floorMonthlyCents);
    expect(RATE_CARD.pro.floorMonthlyCents).toBeLessThan(RATE_CARD.business.floorMonthlyCents);
    expect(RATE_CARD.free.includedDoors).toBeLessThan(RATE_CARD.pro.includedDoors);
    expect(RATE_CARD.pro.includedDoors).toBeLessThan(RATE_CARD.business.includedDoors);
  });
});

describe("priceForDoors", () => {
  it("returns the floor alone when doors are under the included count", () => {
    expect(priceForDoors("pro", 5, "monthly")).toBe(4_900);
    expect(priceForDoors("business", 50, "monthly")).toBe(24_900);
  });

  it("returns the floor alone when doors exactly match the included count", () => {
    expect(priceForDoors("pro", 20, "monthly")).toBe(4_900);
    expect(priceForDoors("business", 120, "annual")).toBe(249_000);
  });

  it("adds floor + overage × rate for doors over the included count (monthly)", () => {
    // Pro: 25 doors = 20 included + 5 extra at $3/door.
    expect(priceForDoors("pro", 25, "monthly")).toBe(4_900 + 5 * 300);
    // Business: 130 doors = 120 included + 10 extra at $2/door.
    expect(priceForDoors("business", 130, "monthly")).toBe(24_900 + 10 * 200);
  });

  it("annualizes the per-door overage rate (×12) for annual billing", () => {
    expect(priceForDoors("pro", 25, "annual")).toBe(49_000 + 5 * 300 * 12);
    expect(priceForDoors("business", 130, "annual")).toBe(249_000 + 10 * 200 * 12);
  });

  it("prices Free at its floor (zero) at or under its 2-door cap", () => {
    expect(priceForDoors("free", 0, "monthly")).toBe(0);
    expect(priceForDoors("free", 2, "monthly")).toBe(0);
    expect(priceForDoors("free", 2, "annual")).toBe(0);
  });

  it("throws pricing Free above its 2-door cap — it has no overage rate", () => {
    expect(() => priceForDoors("free", 3, "monthly")).toThrow(/no overage rate/i);
    expect(() => priceForDoors("free", 3, "annual")).toThrow(/no overage rate/i);
  });

  it("throws on a negative door count", () => {
    expect(() => priceForDoors("pro", -1, "monthly")).toThrow(/non-negative/i);
  });
});

describe("formatRateCardUsd", () => {
  it("formats whole-dollar cents with no decimals, comma-grouped over $999", () => {
    expect(formatRateCardUsd(0)).toBe("$0");
    expect(formatRateCardUsd(4_900)).toBe("$49");
    expect(formatRateCardUsd(49_000)).toBe("$490");
    expect(formatRateCardUsd(249_000)).toBe("$2,490");
  });
});

describe("annualDiscountPercent", () => {
  it("is 0 for a free floor", () => {
    expect(annualDiscountPercent("free")).toBe(0);
  });

  it("computes the real discount vs. paying the monthly floor 12 times", () => {
    // Pro: $49 × 12 = $588/yr paid monthly vs. $490/yr annual = ~16.7% off.
    expect(annualDiscountPercent("pro")).toBe(17);
    // Business: $249 × 12 = $2,988/yr paid monthly vs. $2,490/yr annual.
    expect(annualDiscountPercent("business")).toBe(17);
  });
});
