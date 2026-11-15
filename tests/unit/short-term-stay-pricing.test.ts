import { describe, expect, it } from "vitest";
import {
  parseShortTermStayChargeTitle,
  shortTermNightlyRate,
  shortTermStayChargeTitle,
  shortTermStayNightCount,
  shortTermStayTier,
  shortTermStayTierLabel,
  shortTermStayTierNote,
  shortTermStayTotalAmount,
} from "@/lib/short-term-stay-pricing";

describe("shortTermStayNightCount", () => {
  it("counts checkout-exclusive nights between check-in and check-out", () => {
    expect(shortTermStayNightCount("2026-03-10", "2026-03-16")).toBe(6);
  });

  it("bills checkout-exclusive nights for PROPLANE-MS5V4JUH dates", () => {
    expect(shortTermStayNightCount("2026-07-31", "2026-08-04")).toBe(4);
    expect(shortTermStayTotalAmount(50, 4)).toBe(200);
  });

  it("returns 1 for a same-day stay span", () => {
    expect(shortTermStayNightCount("2026-03-10", "2026-03-10")).toBe(1);
  });

  it("returns null when dates are missing", () => {
    expect(shortTermStayNightCount("", "2026-03-16")).toBeNull();
  });
});

describe("shortTermStayTotalAmount", () => {
  it("multiplies nightly rate by nights", () => {
    expect(shortTermStayTotalAmount(85, 6)).toBe(510);
  });

  it("prorates a weekly-only rate per night from 7 nights, and leaves under a week unpriced", () => {
    expect(shortTermStayTotalAmount(0, 7, 350)).toBe(350);
    expect(shortTermStayTotalAmount(0, 8, 350)).toBe(400);
    expect(shortTermStayTotalAmount(0, 6, 350)).toBe(0);
    expect(shortTermStayTotalAmount(65, 8, 350)).toBe(400);
  });

  it.each([
    ["standard", 50, 300, 1000],
    ["premium", 60, 360, 1200],
  ])("%s room tiers: nightly, weekly (default 6 x nightly), monthly", (_name, nightly, weekly, monthly) => {
    expect(shortTermStayTotalAmount(nightly, 3, undefined, monthly)).toBe(nightly * 3);
    expect(shortTermStayTotalAmount(nightly, 6, undefined, monthly)).toBe(nightly * 6);
    expect(shortTermStayTotalAmount(nightly, 7, undefined, monthly)).toBe(weekly);
    expect(shortTermStayTotalAmount(nightly, 7, weekly, monthly)).toBe(weekly);
    expect(shortTermStayTotalAmount(nightly, 10, undefined, monthly)).toBe(Number(((weekly * 10) / 7).toFixed(2)));
    expect(shortTermStayTotalAmount(nightly, 27, undefined, monthly)).toBe(Number(((weekly * 27) / 7).toFixed(2)));
    expect(shortTermStayTotalAmount(nightly, 28, undefined, monthly)).toBe(Number(((monthly * 28) / 30).toFixed(2)));
    expect(shortTermStayTotalAmount(nightly, 30, undefined, monthly)).toBe(monthly);
    // Without a monthly rate a long stay stays on the weekly tier.
    expect(shortTermStayTotalAmount(nightly, 30)).toBe(Number(((weekly * 30) / 7).toFixed(2)));
  });

  it("names the tier", () => {
    expect(shortTermStayTier(6, 1000)).toBe("nightly");
    expect(shortTermStayTier(7, 1000)).toBe("weekly");
    expect(shortTermStayTier(27, 1000)).toBe("weekly");
    expect(shortTermStayTier(28, 1000)).toBe("monthly");
    expect(shortTermStayTier(28)).toBe("weekly");
    expect(shortTermStayTierLabel("monthly")).toBe("Monthly rate");
    expect(shortTermStayTierNote(3, 50)).toBe("Nightly: 3 nights × $50");
    expect(shortTermStayTierNote(30, 50, undefined, 1000)).toBe("30 nights × $1000/month, Monthly rate");
  });

  it("returns 0 when rate or nights are invalid", () => {
    expect(shortTermStayTotalAmount(0, 6)).toBe(0);
    expect(shortTermStayTotalAmount(85, 0)).toBe(0);
  });
});

describe("shortTermNightlyRate", () => {
  it("parses dollar strings", () => {
    expect(shortTermNightlyRate("$85")).toBe(85);
    expect(shortTermNightlyRate("40.50")).toBe(40.5);
  });

  it("defaults blank to zero", () => {
    expect(shortTermNightlyRate("")).toBe(0);
    expect(shortTermNightlyRate(undefined)).toBe(0);
  });
});

describe("shortTermStayChargeTitle", () => {
  it("formats the stay total line shown in payments", () => {
    expect(shortTermStayChargeTitle(6, 85)).toBe("Stay total (6 nights × $85)");
    expect(shortTermStayChargeTitle(1, 85)).toBe("Stay total (1 night × $85)");
    expect(shortTermStayChargeTitle(4, 50)).toBe("Stay total (4 nights × $50)");
  });
});

describe("parseShortTermStayChargeTitle", () => {
  it("parses stay total titles", () => {
    expect(parseShortTermStayChargeTitle("Stay total (5 nights × $50)")).toEqual({
      nights: 5,
      nightlyRate: 50,
    });
    expect(parseShortTermStayChargeTitle("Stay total (1 night × $85)")).toEqual({
      nights: 1,
      nightlyRate: 85,
    });
  });

  it("returns null for non-stay titles", () => {
    expect(parseShortTermStayChargeTitle("Security deposit")).toBeNull();
  });
});
