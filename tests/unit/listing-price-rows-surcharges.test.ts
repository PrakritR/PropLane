/**
 * Listing Costs: the month-to-month and custom-term surcharges are their own labelled rows behind the same
 * lease-length / Seattle gate billing uses, the first month is always "Prorated by day" with the formula as
 * its tooltip, and the generic fee rows never list the same surcharge a second time.
 */
import { describe, expect, it } from "vitest";
import { FIRST_MONTH_DAILY_RATE_PRORATION_FORMULA, FIRST_MONTH_PRORATION_FORMULA, listingPriceRows } from "@/lib/listing-price-line";

const rich = (pricingBreakdown: Array<{ label: string; value: string }> = []) => ({
  startingRentLabel: "$1,000/mo",
  priceRangeLabel: "",
  floorPlans: [],
  pricingBreakdown,
  estimatedMonthlyTotalLabel: undefined,
});

const offered = { allowedLeaseTerms: ["Month-to-Month", "Custom"], city: "Tacoma", state: "WA" };
const byKey = (rows: ReturnType<typeof listingPriceRows>, key: string) => rows.find((r) => r.key === key);

describe("listingPriceRows surcharge rows", () => {
  it("adds Month-to-month and Custom term rows when set and offered", () => {
    const rows = listingPriceRows(rich(), { ...offered, monthToMonthSurcharge: "25", customLeaseSurcharge: "$100" }, 0);
    expect(byKey(rows, "month-to-month")).toMatchObject({ label: "Month-to-month", value: "+$25/mo" });
    expect(byKey(rows, "custom-term")).toMatchObject({ label: "Custom term · starts any day", value: "+$100/mo" });
  });

  it("adds nothing for empty or zero surcharges", () => {
    const rows = listingPriceRows(rich(), { ...offered, monthToMonthSurcharge: "", customLeaseSurcharge: "0" }, 0);
    expect(byKey(rows, "month-to-month")).toBeUndefined();
    expect(byKey(rows, "custom-term")).toBeUndefined();
  });

  it("hides month-to-month when the listing does not offer it", () => {
    const rows = listingPriceRows(
      rich(),
      { allowedLeaseTerms: ["Custom"], city: "Tacoma", state: "WA", monthToMonthSurcharge: "25", customLeaseSurcharge: "100" },
      0,
    );
    expect(byKey(rows, "month-to-month")).toBeUndefined();
    expect(byKey(rows, "custom-term")).toBeDefined();
  });

  it("hides both on a Seattle listing (monthly fees fold into rent), including a Seattle property record", () => {
    const seattle = { ...offered, city: "Seattle", monthToMonthSurcharge: "25", customLeaseSurcharge: "100" };
    const rows = listingPriceRows(rich(), seattle, 0);
    expect(byKey(rows, "month-to-month")).toBeUndefined();
    expect(byKey(rows, "custom-term")).toBeUndefined();
    const noCity = { allowedLeaseTerms: offered.allowedLeaseTerms, monthToMonthSurcharge: "25", customLeaseSurcharge: "100" };
    const viaProperty = listingPriceRows(rich(), noCity, 0, (v) => v, { city: "Seattle", state: "WA" });
    expect(byKey(viaProperty, "month-to-month")).toBeUndefined();
    expect(byKey(viaProperty, "custom-term")).toBeUndefined();
  });

  it("does not list the same surcharge twice from the generic fee rows", () => {
    const rows = listingPriceRows(
      rich([
        { label: "Month-to-month surcharge", value: "$25" },
        { label: "Custom lease", value: "$100" },
        { label: "Parking", value: "$50" },
      ]),
      { ...offered, monthToMonthSurcharge: "25", customLeaseSurcharge: "100" },
      0,
    );
    expect(rows.filter((r) => /month-to-month/i.test(r.label))).toHaveLength(1);
    expect(rows.filter((r) => /custom/i.test(r.label))).toHaveLength(1);
    expect(rows.some((r) => r.label === "Parking")).toBe(true);
  });

  it("always shows First month as prorated by day, with the formula as a tooltip", () => {
    const rows = listingPriceRows(rich(), { ...offered }, 0);
    expect(byKey(rows, "first-month")).toEqual({
      key: "first-month",
      label: "First month",
      value: "Prorated by day",
      title: FIRST_MONTH_PRORATION_FORMULA,
    });
  });

  it("never quotes the monthly-rent formula when a room (or the home) is priced per day", () => {
    const perDayRoom = listingPriceRows(
      rich(),
      { ...offered, rooms: [{ id: "r1", name: "Room 1" }, { id: "r2", name: "Room 2", prorateMethod: "daily_rate", dailyRentRate: 120 }] } as never,
      0,
    );
    expect(byKey(perDayRoom, "first-month")!.title).toBe(FIRST_MONTH_DAILY_RATE_PRORATION_FORMULA);

    const perDayHome = listingPriceRows(rich(), { ...offered, entireHomeProrateMethod: "daily_rate" }, 0);
    expect(byKey(perDayHome, "first-month")!.title).toBe(FIRST_MONTH_DAILY_RATE_PRORATION_FORMULA);

    const perResidentRow = listingPriceRows(
      rich(),
      { ...offered, rooms: [{ id: "r1", name: "Room 1", residentPrices: [{ slot: 1, monthlyRent: 1200, prorateMethod: "daily_rate", dailyRentRate: 60 }] }] } as never,
      0,
    );
    expect(byKey(perResidentRow, "first-month")!.title).toBe(FIRST_MONTH_DAILY_RATE_PRORATION_FORMULA);
  });
});
