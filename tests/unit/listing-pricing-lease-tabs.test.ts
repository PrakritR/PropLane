import { describe, expect, it } from "vitest";
import {
  listingPricingLeaseTabs,
  listingPricingTabToLeaseTerm,
} from "@/lib/listing-fee-scope";
import { LONG_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";
import { normalizeLongTermLengths } from "@/lib/manager-listing-submission";

describe("listingPricingLeaseTabs", () => {
  it("collapses legacy fixed lengths and Long-term onto one 12-Month tab", () => {
    const tabs = listingPricingLeaseTabs({
      allowedLeaseTerms: ["3-Month", "6-Month", "9-Month", "12-Month", LONG_TERM_LEASE_TERM, "Month-to-Month"],
      leaseTermsBody: "",
      shortTermRentalsAllowed: false,
      airbnbRentalsAllowed: false,
    });
    expect(tabs).toContain("12-Month");
    expect(tabs).not.toContain("3-Month");
    expect(tabs).not.toContain("6-Month");
    expect(tabs).not.toContain("9-Month");
    expect(tabs).not.toContain(LONG_TERM_LEASE_TERM);
    expect(tabs).toContain("Month-to-Month");
  });

  it("maps the 12-Month tab to Long-term for rent reads", () => {
    expect(listingPricingTabToLeaseTerm("12-Month")).toBe(LONG_TERM_LEASE_TERM);
  });
});

describe("normalizeLongTermLengths", () => {
  it("accepts every month from 1 through 12", () => {
    expect(normalizeLongTermLengths([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
  });
});
