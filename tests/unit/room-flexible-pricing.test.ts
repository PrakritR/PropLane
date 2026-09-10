import { describe, expect, it } from "vitest";
import {
  normalizeManagerListingSubmissionV1,
  normalizeFlexibleRentBound,
  normalizeShortLeaseMaxMonths,
} from "@/lib/manager-listing-submission";
import {
  resolveStayPricing,
  roomHeadlinePriceLabel,
  roomIsWeeklyPriced,
  roomMonthlyEquivalent,
  tenancyPaysShortLeaseSurcharge,
  roomAdvertisedPriceLabel,
  roomFlexibleRange,
  roomFlexibleSortAmount,
  roomPricingIsFlexible,
  roomShortLeaseListingNote,
} from "@/lib/room-pricing";

const flexible = (over: Record<string, unknown> = {}) => ({
  monthlyRent: 800,
  pricingMode: "flexible" as const,
  ...over,
});

describe("PRP-462 flexible room pricing (= Fixed fields, Communication differs)", () => {
  it("leaves an existing room fixed-price with no edits", () => {
    const sub = normalizeManagerListingSubmissionV1({
      v: 1,
      bathrooms: [],
      sharedSpaces: [],
      rooms: [{ id: "r1", name: "Room 1", monthlyRent: 825 }],
    });
    expect(sub.rooms[0]!.pricingMode).toBe("fixed");
    expect(roomPricingIsFlexible(sub.rooms[0])).toBe(false);
    expect(roomAdvertisedPriceLabel(sub.rooms[0])).toBe("$825/mo");
  });

  it("bills the listed rent for a flexible room (same as Fixed)", () => {
    const pricing = resolveStayPricing({ room: flexible(), submission: null, application: null });
    expect(pricing.monthlyRate).toBe(800);
    expect(pricing.source).toBe("room");
  });

  it("bills a flexible room's daily price when billed by day", () => {
    const pricing = resolveStayPricing({
      room: flexible({ rentBasis: "daily", dailyRentPrice: 40, monthlyRent: 0 }),
      submission: { shortTermRentalsAllowed: true },
      application: null,
    });
    expect(pricing.dailyRate).toBe(40);
  });

  it("still prefers a per-resident negotiated override when set", () => {
    const pricing = resolveStayPricing({
      room: flexible(),
      submission: null,
      application: { managerRentOverride: "525" },
    });
    expect(pricing.monthlyRate).toBe(525);
    expect(pricing.source).toBe("application_override");
  });

  it("gives two residents their own overrides on one flexible room", () => {
    const room = flexible();
    const a = resolveStayPricing({ room, submission: null, application: { managerRentOverride: "500" } });
    const b = resolveStayPricing({ room, submission: null, application: { signedMonthlyRent: 900 } });
    expect(a.monthlyRate).toBe(500);
    expect(b.monthlyRate).toBe(900);
  });

  describe("advertised label", () => {
    it("shows listed rent with · Flexible", () => {
      expect(roomAdvertisedPriceLabel(flexible())).toBe("$800/mo · Flexible");
    });
    it("falls back to legacy Min/Max only when no listed rent", () => {
      expect(
        roomAdvertisedPriceLabel(flexible({ monthlyRent: 0, flexibleRentMin: 600, flexibleRentMax: 900 })),
      ).toBe("$600–$900/mo · Flexible");
    });
    it("does not invent $0 when nothing is listed", () => {
      expect(roomAdvertisedPriceLabel(flexible({ monthlyRent: 0 }))).toBe(
        "Flexible · Contact manager to discuss pricing",
      );
    });
  });

  describe("sort amount", () => {
    it("uses listed rent when present", () => {
      expect(roomFlexibleSortAmount(flexible())).toBe(800);
    });
    it("uses legacy min when no listed rent", () => {
      expect(roomFlexibleSortAmount(flexible({ monthlyRent: 0, flexibleRentMin: 600 }))).toBe(600);
    });
  });

  it("still resolves the deposit", () => {
    const pricing = resolveStayPricing({
      room: flexible({ securityDeposit: "400" }),
      submission: null,
      application: null,
    });
    expect(pricing.deposit).toBe(400);
    expect(pricing.monthlyRate).toBe(800);
  });

  it("keeps roomFlexibleRange for legacy guidance", () => {
    expect(roomFlexibleRange(flexible({ flexibleRentMin: 600, flexibleRentMax: 900 }))).toEqual({
      min: 600,
      max: 900,
    });
    expect(normalizeFlexibleRentBound("  450 ")).toBe(450);
  });

  it("still supports weekly short-lease helpers used by Fixed+Flexible fields", () => {
    expect(roomIsWeeklyPriced({ rentBasis: "weekly", weeklyRentPrice: 350 })).toBe(true);
    expect(roomMonthlyEquivalent({ rentBasis: "weekly", weeklyRentPrice: 350 })).toBeGreaterThan(0);
    expect(roomHeadlinePriceLabel({ rentBasis: "weekly", weeklyRentPrice: 350 })).toBe("$350/week");
    expect(normalizeShortLeaseMaxMonths("3")).toBe(3);
    expect(
      tenancyPaysShortLeaseSurcharge(
        { shortLeaseMaxMonths: 3, shortLeaseSurchargeMonthly: "150" },
        { leaseStart: "2026-01-01", leaseEnd: "2026-03-01" },
      ),
    ).toBe(true);
    expect(roomShortLeaseListingNote({ shortLeaseSurchargeMonthly: "150", shortLeaseMaxMonths: 3 })).toMatch(
      /\$150\/mo/,
    );
  });
});
