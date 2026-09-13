import { describe, expect, it } from "vitest";
import { paymentAtSigningMatrix, listingPricingLeaseTabs, listingPricingTabToLeaseTerm } from "@/lib/listing-fee-scope";
import { applyPaymentAtSigningCell } from "@/lib/listing-fees";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

/**
 * A listing that still stores a retired length (3/6/9/12-Month) is PRESENTED as
 * Long-term everywhere — the pricing tab, the applicant's dropdown, the signing
 * heading. The at-signing matrix, though, was keyed by whatever the listing
 * STORED, so the screen read and wrote `Long-term` while the matrix only had a
 * `12-Month` row. Every tick was written and then dropped on the next render,
 * and the control sat on "Nothing due at signing" forever (captain, 2026-09-13).
 */
const legacyListing = () =>
  ({
    allowedLeaseTerms: ["12-Month"],
    leaseTermsBody: "",
    shortTermRentalsAllowed: false,
    airbnbRentalsAllowed: false,
    paymentAtSigningByLeaseType: undefined,
    paymentAtSigningIncludes: [],
    customFees: [],
    rooms: [],
    removedStandardListingFeeRows: [],
  }) as unknown as ManagerListingSubmissionV1;

describe("at-signing on a listing that stored a retired length", () => {
  it("keys the matrix by the term the screen actually shows", () => {
    const sub = legacyListing();
    const tab = listingPricingLeaseTabs(sub)[0];
    const leaseTerm = listingPricingTabToLeaseTerm(tab);
    expect(leaseTerm).toBe("Long-term");

    const matrix = paymentAtSigningMatrix(sub);
    // The row the screen reads and writes must exist, or every tick is dropped.
    expect(Object.keys(matrix)).toContain(leaseTerm);
  });

  it("keeps a ticked payment instead of silently discarding it", () => {
    const sub = legacyListing();
    const leaseTerm = listingPricingTabToLeaseTerm(listingPricingLeaseTabs(sub)[0]);

    const after = applyPaymentAtSigningCell(sub, leaseTerm, "first_month_rent", true);
    // Re-read the way the component does on the next render.
    const reread = paymentAtSigningMatrix(after);
    expect(reread[leaseTerm] ?? []).toContain("first_month_rent");
  });

  it("still round-trips on a listing that stores Long-term outright", () => {
    const sub = { ...legacyListing(), allowedLeaseTerms: ["Long-term"] } as ManagerListingSubmissionV1;
    const after = applyPaymentAtSigningCell(sub, "Long-term", "first_month_rent", true);
    expect(paymentAtSigningMatrix(after)["Long-term"] ?? []).toContain("first_month_rent");
  });
});
