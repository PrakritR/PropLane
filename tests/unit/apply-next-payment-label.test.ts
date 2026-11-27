import { describe, expect, it } from "vitest";
import { quoteNextPaymentLabel } from "@/lib/rental-application/listing-fees-display";

const firstMonth = { billableDays: 4, daysInMonth: 30, monthLabel: "November", amount: 146.67, utilities: 0 };

describe("quoteNextPaymentLabel", () => {
  it("names the 1st of the next month after a prorated first month", () => {
    expect(quoteNextPaymentLabel({ isStay: false, proration: { firstMonth, lastMonth: null } }, "2026-11-27")).toBe("Dec 1");
  });
  it("rolls the year in December", () => {
    expect(quoteNextPaymentLabel({ isStay: false, proration: { firstMonth, lastMonth: null } }, "2026-12-20")).toBe("Jan 1");
  });
  it("is null for a whole first month, a stay, or no start date", () => {
    expect(quoteNextPaymentLabel({ isStay: false, proration: { firstMonth: null, lastMonth: null } }, "2026-12-01")).toBeNull();
    expect(quoteNextPaymentLabel({ isStay: true, proration: { firstMonth, lastMonth: null } }, "2026-11-27")).toBeNull();
    expect(quoteNextPaymentLabel({ isStay: false, proration: { firstMonth, lastMonth: null } }, "")).toBeNull();
  });
});
