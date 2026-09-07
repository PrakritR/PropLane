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
  monthlyRent: 700,
  pricingMode: "flexible" as const,
  ...over,
});

describe("PRP-329 flexible room pricing", () => {
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

  // The whole point of the feature: the advertised figure is guidance, and the
  // room's old fixed rent must not survive as a hidden billable amount.
  it("never bills an advertised range, and never falls back to the stale fixed rent", () => {
    const pricing = resolveStayPricing({ room: flexible(), submission: null, application: null });
    expect(pricing.monthlyRate).toBeUndefined();
    expect(pricing.dailyRate).toBeUndefined();
  });

  it("does not bill a flexible room's daily price either", () => {
    const pricing = resolveStayPricing({
      room: flexible({ rentBasis: "daily", dailyRentPrice: 40 }),
      submission: { shortTermRentalsAllowed: true },
      application: null,
    });
    expect(pricing.monthlyRate).toBeUndefined();
    expect(pricing.dailyRate).toBeUndefined();
  });

  it("bills the manager's agreed rent for this resident once it is set", () => {
    const pricing = resolveStayPricing({
      room: flexible(),
      submission: null,
      application: { managerRentOverride: "525" },
    });
    expect(pricing.monthlyRate).toBe(525);
    expect(pricing.source).toBe("application_override");
  });

  // Acceptance 4: two residents, one room, different agreed rents.
  it("gives two residents in one room their own agreed rents", () => {
    const room = flexible();
    const a = resolveStayPricing({ room, submission: null, application: { managerRentOverride: "500" } });
    const b = resolveStayPricing({ room, submission: null, application: { signedMonthlyRent: 900 } });
    expect(a.monthlyRate).toBe(500);
    expect(b.monthlyRate).toBe(900);
  });

  it("still resolves the deposit, which is agreed separately from rent", () => {
    const pricing = resolveStayPricing({
      room: flexible({ securityDeposit: "400" }),
      submission: null,
      application: null,
    });
    expect(pricing.deposit).toBe(400);
    expect(pricing.monthlyRate).toBeUndefined();
  });

  describe("advertised label", () => {
    it("shows a full range per period", () => {
      expect(roomAdvertisedPriceLabel(flexible({ flexibleRentMin: 600, flexibleRentMax: 900 }))).toBe(
        "$600–$900/mo · Flexible pricing",
      );
    });
    it("shows one bound honestly rather than inventing the other", () => {
      expect(roomAdvertisedPriceLabel(flexible({ flexibleRentMin: 600 }))).toBe(
        "From $600/mo · Flexible pricing",
      );
      expect(roomAdvertisedPriceLabel(flexible({ flexibleRentMax: 900 }))).toBe(
        "Up to $900/mo · Flexible pricing",
      );
    });
    // Acceptance 2: clearing the range must not render $0.
    it("says contact the manager when no bounds are set, never $0", () => {
      const label = roomAdvertisedPriceLabel(flexible());
      expect(label).toBe("Flexible pricing · Contact manager to discuss pricing");
      expect(label).not.toContain("$0");
    });
  });

  describe("range validation", () => {
    it("drops a maximum below the minimum instead of showing it reversed", () => {
      const sub = normalizeManagerListingSubmissionV1({
        v: 1,
        bathrooms: [],
        sharedSpaces: [],
        rooms: [{ id: "r1", name: "R", monthlyRent: 0, pricingMode: "flexible", flexibleRentMin: 900, flexibleRentMax: 600 }],
      });
      expect(sub.rooms[0]!.flexibleRentMax).toBeUndefined();
      expect(roomAdvertisedPriceLabel(sub.rooms[0])).toBe("From $900/mo · Flexible pricing");
    });
    it("treats blank, negative and zero bounds as unset", () => {
      for (const raw of ["", "  ", "-50", "0", "abc", null, undefined]) {
        expect(normalizeFlexibleRentBound(raw)).toBeUndefined();
      }
      expect(normalizeFlexibleRentBound("$1,200")).toBe(1200);
    });
    it("fails closed to fixed on an unreadable mode, keeping the advertised price", () => {
      const sub = normalizeManagerListingSubmissionV1({
        v: 1,
        bathrooms: [],
        sharedSpaces: [],
        rooms: [{ id: "r1", name: "R", monthlyRent: 825, pricingMode: "wobbly" }],
      });
      expect(sub.rooms[0]!.pricingMode).toBe("fixed");
      expect(roomAdvertisedPriceLabel(sub.rooms[0])).toBe("$825/mo");
    });
  });

  describe("browse ranking", () => {
    // Acceptance 6: honest sorting, never a fabricated midpoint or $0.
    it("ranks on the advertised minimum, not a midpoint the manager never wrote", () => {
      expect(roomFlexibleSortAmount(flexible({ flexibleRentMin: 600, flexibleRentMax: 900 }))).toBe(600);
    });
    it("leaves an unpriced flexible room unranked rather than sorting it as free", () => {
      expect(roomFlexibleSortAmount(flexible())).toBeUndefined();
      expect(roomFlexibleRange(flexible())).toBeNull();
    });
    it("never reports a range for a fixed room", () => {
      expect(roomFlexibleRange({ monthlyRent: 825 })).toBeNull();
      expect(roomFlexibleSortAmount({ monthlyRent: 825 })).toBeUndefined();
    });
  });
});

describe("rate card and short-lease surcharge", () => {
  const room = (over: Record<string, unknown> = {}) => ({
    monthlyRent: 1000,
    shortLeaseSurchargeMonthly: "150",
    shortLeaseMaxMonths: 3,
    ...over,
  });
  const lease = (start: string, end: string) => ({ leaseStart: start, leaseEnd: end });

  it("quotes ONE number with the surcharge folded in, and keeps the breakdown", () => {
    const p = resolveStayPricing({ room: room(), submission: null, application: lease("2026-10-01", "2026-12-31") });
    expect(p.monthlyRate).toBe(1150);
    expect(p.shortLeaseSurcharge).toBe(150);
  });

  it("does not surcharge a full-length tenancy", () => {
    const p = resolveStayPricing({ room: room(), submission: null, application: lease("2026-10-01", "2027-09-30") });
    expect(p.monthlyRate).toBe(1000);
    expect(p.shortLeaseSurcharge).toBe(0);
  });

  it("applies at the threshold and not past it", () => {
    expect(tenancyPaysShortLeaseSurcharge(room(), lease("2026-10-01", "2026-12-31"))).toBe(true);
    expect(tenancyPaysShortLeaseSurcharge(room(), lease("2026-10-01", "2027-01-31"))).toBe(false);
  });

  // A nightly stay is already priced for being short.
  it("never doubles up with an explicit short-term stay", () => {
    expect(
      tenancyPaysShortLeaseSurcharge(room(), { ...lease("2026-10-01", "2026-10-20"), rentalType: "short_term" }),
    ).toBe(false);
  });

  // Guessing here would raise rent on every lease whose dates are not filled in.
  it("never surcharges an undated lease", () => {
    expect(tenancyPaysShortLeaseSurcharge(room(), {})).toBe(false);
  });

  it("treats a weekly rate as a real quoted rate, not the monthly one divided", () => {
    const weekly = { monthlyRent: 1000, rentBasis: "weekly" as const, weeklyRentPrice: 350 };
    expect(roomIsWeeklyPriced(weekly)).toBe(true);
    expect(roomHeadlinePriceLabel(weekly)).toBe("$350/week");
    // 52/12 weeks, never 4 — four would understate it against every monthly room.
    expect(roomMonthlyEquivalent(weekly)).toBeCloseTo(1516.67, 1);
    const pricing = resolveStayPricing({ room: weekly, submission: null, application: null });
    expect(pricing.basis).toBe("weekly");
    expect(pricing.weeklyRate).toBe(350);
  });

  it("surfaces a short-lease surcharge note on listings", () => {
    expect(
      roomShortLeaseListingNote({
        shortLeaseSurchargeMonthly: "150",
        shortLeaseMaxMonths: 3,
      }),
    ).toBe("+$150/mo on leases of 3 months or less");
  });

  it("falls back to monthly when a basis names a rate that was left blank", () => {
    const sub = normalizeManagerListingSubmissionV1({
      v: 1,
      bathrooms: [],
      sharedSpaces: [],
      rooms: [{ id: "r1", name: "R", monthlyRent: 1000, rentBasis: "weekly" }],
    });
    expect(sub.rooms[0]!.rentBasis).toBe("monthly");
  });

  // "Short" is 2 months to one manager and 6 to another, so the product does not get
  // to pick. No window set means the surcharge simply never applies — the failure
  // direction is always "charge less", never a window nobody agreed to.
  it("invents no short-lease window of its own", () => {
    expect(normalizeShortLeaseMaxMonths(undefined)).toBeUndefined();
    expect(normalizeShortLeaseMaxMonths("")).toBeUndefined();
    expect(normalizeShortLeaseMaxMonths(0)).toBeUndefined();
    expect(normalizeShortLeaseMaxMonths("2")).toBe(2);
    expect(normalizeShortLeaseMaxMonths(6)).toBe(6);
  });

  it("charges no surcharge when the manager never said what short means", () => {
    const noWindow = { monthlyRent: 1000, shortLeaseSurchargeMonthly: "150" };
    expect(tenancyPaysShortLeaseSurcharge(noWindow, lease("2026-10-01", "2026-12-31"))).toBe(false);
    const p = resolveStayPricing({ room: noWindow, submission: null, application: lease("2026-10-01", "2026-12-31") });
    expect(p.monthlyRate).toBe(1000);
    expect(p.shortLeaseSurcharge).toBe(0);
  });

  it("honours whatever window the manager did set", () => {
    const sixMonths = room({ shortLeaseMaxMonths: 6 });
    expect(tenancyPaysShortLeaseSurcharge(sixMonths, lease("2026-10-01", "2027-03-31"))).toBe(true);
    expect(tenancyPaysShortLeaseSurcharge(sixMonths, lease("2026-10-01", "2027-04-30"))).toBe(false);
  });
});
