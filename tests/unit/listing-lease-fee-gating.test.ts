import { describe, expect, it } from "vitest";
import { createDefaultListingSubmission, normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { leaseDocumentFeeLines, listingFeeDisplayRows } from "@/lib/listing-fees";
import {
  applyListingLtFeeToggle,
  deriveListingLtFeeToggles,
  leaseLengthGatedHiddenFeeRowIds,
  listingOffersCustomLeaseSurcharge,
  listingOffersMonthToMonthSurcharge,
  listingPresetFeeAmountIfEnabled,
} from "@/lib/listing-fee-term-toggles";

describe("listing lease-length fee gating", () => {
  it("hides MTM surcharge until Month-to-Month is offered", () => {
    const sub = createDefaultListingSubmission();
    sub.allowedLeaseTerms = ["12-Month"];
    sub.monthToMonthSurcharge = "25";
    expect(listingOffersMonthToMonthSurcharge(sub)).toBe(false);
    expect(leaseLengthGatedHiddenFeeRowIds(sub).has("monthToMonthSurcharge")).toBe(true);

    sub.allowedLeaseTerms = ["Month-to-Month"];
    expect(listingOffersMonthToMonthSurcharge(sub)).toBe(true);
    expect(leaseLengthGatedHiddenFeeRowIds(sub).has("monthToMonthSurcharge")).toBe(false);
  });

  it("shows custom lease surcharge when Custom or Long-term is offered", () => {
    const sub = createDefaultListingSubmission();
    sub.allowedLeaseTerms = ["Month-to-Month"];
    expect(listingOffersCustomLeaseSurcharge(sub)).toBe(false);

    sub.allowedLeaseTerms = ["Custom"];
    expect(listingOffersCustomLeaseSurcharge(sub)).toBe(true);

    sub.allowedLeaseTerms = ["Long-term"];
    expect(listingOffersCustomLeaseSurcharge(sub)).toBe(true);
  });

  it("does not bill preset fees when the long-term checkbox is off", () => {
    let sub = createDefaultListingSubmission();
    sub.securityDeposit = "400";
    expect(listingPresetFeeAmountIfEnabled(sub, "security_deposit")).toBe(400);

    sub = applyListingLtFeeToggle(sub, "securityDeposit", false);
    expect(deriveListingLtFeeToggles(sub).securityDeposit).toBe(false);
    expect(listingPresetFeeAmountIfEnabled(sub, "security_deposit")).toBe(0);
  });
});

/**
 * The gate has to hold everywhere the fee is READ, not just in the wizard that hides the row
 * (PRP-218). Both readers below filtered on amount alone, so a listing that dropped
 * Month-to-Month from its lease terms kept advertising the month-to-month surcharge on its
 * public page and printing it into the lease document.
 */
describe("lease-length gating reaches the listing and lease readers", () => {
  function surchargeListing(terms: string[]) {
    const sub = createDefaultListingSubmission();
    sub.allowedLeaseTerms = terms as never;
    sub.monthToMonthSurcharge = "25";
    sub.customLeaseSurcharge = "40";
    return normalizeManagerListingSubmissionV1(sub);
  }

  const labels = (rows: { title: string; id: string }[]) => rows.map((r) => `${r.id} ${r.title}`);

  it("omits both surcharges from the public listing rows when neither term is offered", () => {
    const rows = listingFeeDisplayRows(surchargeListing(["Month-to-Month"]), (raw) => raw);
    expect(labels(rows).join(" | ")).not.toMatch(/custom lease/i);

    const noMtm = listingFeeDisplayRows(surchargeListing(["12-Month"]), (raw) => raw);
    expect(labels(noMtm).join(" | ")).not.toMatch(/month-to-month/i);
  });

  it("still shows a surcharge whose lease length IS offered", () => {
    const rows = listingFeeDisplayRows(surchargeListing(["Month-to-Month"]), (raw) => raw);
    expect(labels(rows).join(" | ")).toMatch(/month-to-month/i);
  });

  it("omits the month-to-month surcharge from the lease document when MTM is not offered", () => {
    const { monthly } = leaseDocumentFeeLines(surchargeListing(["12-Month"]));
    expect(monthly.map((l) => l.label).join(" | ")).not.toMatch(/month-to-month/i);

    const offered = leaseDocumentFeeLines(surchargeListing(["Month-to-Month"]));
    expect(offered.monthly.map((l) => l.label).join(" | ")).toMatch(/month-to-month/i);
  });
});
