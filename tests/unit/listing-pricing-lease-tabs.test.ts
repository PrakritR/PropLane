import { describe, expect, it } from "vitest";
import {
  listingPricingLeaseTabs,
  listingPricingTabToLeaseTerm,
} from "@/lib/listing-fee-scope";
import { LONG_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";
import { normalizeLongTermLengths } from "@/lib/manager-listing-submission";

describe("listingPricingLeaseTabs", () => {
  it("collapses legacy fixed lengths onto one tab, named for the term and not a length", () => {
    const tabs = listingPricingLeaseTabs({
      allowedLeaseTerms: ["3-Month", "6-Month", "9-Month", "12-Month", LONG_TERM_LEASE_TERM, "Month-to-Month"],
      leaseTermsBody: "",
      shortTermRentalsAllowed: false,
      airbnbRentalsAllowed: false,
    });
    // The product stopped offering named lengths — the dates are the term — so
    // the tab must not advertise one the manager can no longer pick.
    expect(tabs).toContain(LONG_TERM_LEASE_TERM);
    expect(tabs).not.toContain("12-Month");
    expect(tabs).not.toContain("3-Month");
    expect(tabs).not.toContain("6-Month");
    expect(tabs).not.toContain("9-Month");
    expect(tabs).toContain("Month-to-Month");
  });

  it("still resolves the retired 12-Month tab id to Long-term", () => {
    expect(listingPricingTabToLeaseTerm("12-Month")).toBe(LONG_TERM_LEASE_TERM);
    expect(listingPricingTabToLeaseTerm(LONG_TERM_LEASE_TERM)).toBe(LONG_TERM_LEASE_TERM);
  });
});

describe("normalizeLongTermLengths", () => {
  it("accepts every month from 1 through 12", () => {
    expect(normalizeLongTermLengths([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
  });
});
