import { describe, expect, it } from "vitest";
import {
  parseShortTermStayChargeTitle,
  shortTermNightlyRate,
  shortTermStayChargeTitle,
  shortTermStayNightCount,
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

  it("never bills only the whole-week portion when leftover nights have no rate", () => {
    expect(shortTermStayTotalAmount(0, 7, 350)).toBe(350);
    expect(shortTermStayTotalAmount(0, 8, 350)).toBe(0);
    expect(shortTermStayTotalAmount(65, 8, 350)).toBe(415);
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
