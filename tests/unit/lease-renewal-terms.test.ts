import { describe, expect, it } from "vitest";
import {
  renewalLeaseTermOptionsForProperty,
  renewalRentalTypeForTerm,
} from "@/lib/lease-renewal-terms";
import { SHORT_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";

describe("renewalRentalTypeForTerm", () => {
  it("maps short-term stay to short_term rental type", () => {
    expect(renewalRentalTypeForTerm(SHORT_TERM_LEASE_TERM)).toBe("short_term");
  });

  it("maps standard lease terms to standard rental type", () => {
    expect(renewalRentalTypeForTerm("12-Month")).toBe("standard");
    expect(renewalRentalTypeForTerm("Month-to-Month")).toBe("standard");
  });
});

describe("renewalLeaseTermOptionsForProperty", () => {
  it("offers the four choices in the default fallback set", () => {
    // The fallback now mirrors what every other picker shows for a listing with
    // no stored terms: Long-term rather than the retired 3/6/9/12-Month lengths
    // (AXI-143). Those are still ACCEPTED when stored, just not offered afresh.
    const options = renewalLeaseTermOptionsForProperty("");
    expect(options).toContain("Long-term");
    expect(options).toContain("Month-to-Month");
    expect(options).toContain(SHORT_TERM_LEASE_TERM);
    expect(options).not.toContain("6-Month");
    expect(options.indexOf("Custom")).toBeGreaterThan(options.indexOf(SHORT_TERM_LEASE_TERM));
  });
});
