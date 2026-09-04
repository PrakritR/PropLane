/**
 * The create wizard's "Other fees" defaults (PRP-220).
 *
 * Two settled decisions this pins, because both are invisible to a build and to every
 * behavioural test — a regression would simply mean a manager stops seeing a fee row, or
 * starts seeing a checkbox that was deliberately retired.
 *
 * 1. The standard fee rows are present by DEFAULT on a new listing. A manager should not have
 *    to discover an "add fee" affordance before they can price parking, HOA or other monthly
 *    fees; rent is the one exclusion, because it lives in its own Rent section.
 * 2. The "rolls over to month-to-month" checkbox is gone from the wizard. The field itself
 *    stays on the submission and still drives the lease clause and the surcharge gate for
 *    listings that already carry it — removing the control is not removing the concept.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  LISTING_STANDARD_FEE_ROWS,
  leaseLengthGatedHiddenFeeRowIds,
  type ListingFeeRowId,
} from "@/lib/listing-fee-term-toggles";
import { removedStandardListingFeeRowSet } from "@/lib/listing-fees";
import { createDefaultListingSubmission, normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

/** The same three inputs `listing-unified-fees-table.tsx` filters `visibleRows` on. */
function defaultOtherFeeRowIds(): ListingFeeRowId[] {
  const sub = normalizeManagerListingSubmissionV1(createDefaultListingSubmission());
  const hidden = leaseLengthGatedHiddenFeeRowIds(sub);
  const removed = removedStandardListingFeeRowSet(sub);
  return LISTING_STANDARD_FEE_ROWS.filter(
    (row) => row.id !== "rent" && !hidden.has(row.id) && !removed.has(row.id as never),
  ).map((row) => row.id);
}

describe("create wizard Other fees defaults", () => {
  it("offers the standard fee rows on a brand-new listing", () => {
    const ids = defaultOtherFeeRowIds();

    expect(ids).toEqual(
      expect.arrayContaining([
        "applicationFee",
        "securityDeposit",
        "moveInFee",
        "holdingDeposit",
        "parkingMonthly",
        "hoaMonthly",
        "otherMonthlyFees",
      ]),
    );
  });

  it("keeps rent out of Other fees — it has its own section", () => {
    expect(defaultOtherFeeRowIds()).not.toContain("rent");
  });

  it("hides both surcharges until the listing offers that lease length", () => {
    const ids = defaultOtherFeeRowIds();
    expect(ids).not.toContain("monthToMonthSurcharge");
    expect(ids).not.toContain("customLeaseSurcharge");
  });

  it("no longer renders a rollover-to-month-to-month checkbox in the wizard", () => {
    const src = readFileSync("src/components/portal/pro-add-listing-form.tsx", "utf8");
    // The memoization dependency is a read, not a control; a rendered checkbox would write.
    expect(src).not.toMatch(/rolloverToMonthToMonth:\s*(true|false|!)/);
    expect(src).not.toMatch(/onChange[^\n]*rolloverToMonthToMonth/);
  });
});
