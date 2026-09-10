/**
 * The create wizard's "Other fees" defaults (PRP-220).
 *
 * Two settled decisions this pins, because both are invisible to a build and to every
 * behavioural test — a regression would simply mean a manager stops seeing a fee row, or
 * starts seeing a checkbox that was deliberately retired.
 *
 * 1. The standard fee rows all EXIST for a listing that has not removed any (an edited
 *    listing from before the removable-rows work, which is what `createDefaultListingSubmission`
 *    models); rent is the one exclusion, because it lives in its own Rent section.
 *    What a manager sees on a BRAND-NEW listing is a different question, answered by
 *    `createNewListingWizardSubmission` and pinned at the bottom of this file: since
 *    PRP-463 that is the Application fee alone.
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
import {
  createDefaultListingSubmission,
  createNewListingWizardSubmission,
  normalizeManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";

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

  // PRP-463: one row, not eight. A new listing asks for the application fee and nothing
  // else; every other standard fee is one "+ Add fee" away.
  it("starts a brand-new listing with the application fee alone", () => {
    const sub = createNewListingWizardSubmission();
    const hidden = leaseLengthGatedHiddenFeeRowIds(sub);
    const removed = removedStandardListingFeeRowSet(sub);
    const ids = LISTING_STANDARD_FEE_ROWS.filter(
      (row) => row.id !== "rent" && !hidden.has(row.id) && !removed.has(row.id as never),
    ).map((row) => row.id);

    expect(ids).toEqual(["applicationFee"]);
  });

  // PRP-463 round 2, both the captain's calls. Neither is visible to a build or to a
  // behavioural test: a regression would just mean a manager silently loses the code box,
  // or gets back a second amount field for the same fee.
  it("offers the PropLane waive code whenever PropLane is the payer, entitled or not", () => {
    const src = readFileSync("src/components/portal/pro-add-listing-form.tsx", "utf8");
    expect(src).toContain('{serviceFeePayerUi === "proplane" ? (');
    expect(src).toContain("PropLane processing waive code");
    // The entitlement check survives, but only to decide whether the code is REQUIRED.
    expect(src).toContain("listingProplaneAbsorbNeedsWaiverCode(");
  });

  it("gives a fee one amount — no separate short-term box", () => {
    const table = readFileSync("src/components/portal/listing-unified-fees-table.tsx", "utf8");
    expect(table).not.toContain("Short-term custom fee");
    expect(table).not.toContain("ariaLabel={`Short-term ${row.label}`}");
    // The amount cell is drawn for a fee scoped to EITHER term, so a short-term-only fee
    // still has somewhere to put its price.
    expect(table).toContain("{(ltOn || stOn) && (row.ltField || row.id === \"rent\") ? (");
  });

  it("no longer renders a rollover-to-month-to-month checkbox in the wizard", () => {
    const src = readFileSync("src/components/portal/pro-add-listing-form.tsx", "utf8");
    // The memoization dependency is a read, not a control; a rendered checkbox would write.
    expect(src).not.toMatch(/rolloverToMonthToMonth:\s*(true|false|!)/);
    expect(src).not.toMatch(/onChange[^\n]*rolloverToMonthToMonth/);
  });
});
