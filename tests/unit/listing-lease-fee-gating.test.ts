import { describe, expect, it } from "vitest";
import { createDefaultListingSubmission, normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { leaseDocumentFeeLines, listingFeeDisplayRows } from "@/lib/listing-fees";
import {
  applyListingLtFeeToggle,
  deriveListingLtFeeToggles,
  leaseLengthGatedHiddenFeeRowIds,
  listingOffersCustomLeaseSurcharge,
  listingPresetFeeAmountIfEnabled,
} from "@/lib/listing-fee-term-toggles";

describe("listing lease-length fee gating", () => {
  it("has no month-to-month surcharge row to gate, offered or not", () => {
    const sub = createDefaultListingSubmission();
    sub.allowedLeaseTerms = ["12-Month"];
    expect([...leaseLengthGatedHiddenFeeRowIds(sub)]).toEqual(["customLeaseSurcharge"].filter((id) => !listingOffersCustomLeaseSurcharge(sub)));
    sub.allowedLeaseTerms = ["Month-to-Month"];
    expect(leaseLengthGatedHiddenFeeRowIds(sub).has("monthToMonthSurcharge" as never)).toBe(false);
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
 * (PRP-218). The month-to-month surcharge is retired, so only the custom-lease surcharge is gated now, and a
 * stale month-to-month value is never shown.
 */
describe("lease-length gating reaches the listing and lease readers", () => {
  function surchargeListing(terms: string[]) {
    const sub = createDefaultListingSubmission();
    sub.allowedLeaseTerms = terms as never;
    // A listing saved while the month-to-month surcharge existed.
    (sub as unknown as Record<string, string>).monthToMonthSurcharge = "25";
    sub.customLeaseSurcharge = "40";
    return normalizeManagerListingSubmissionV1(sub);
  }

  const labels = (rows: { title: string; id: string }[]) => rows.map((r) => `${r.id} ${r.title}`);

  it("omits the custom-lease surcharge from the public listing rows when Custom is not offered", () => {
    const rows = listingFeeDisplayRows(surchargeListing(["Month-to-Month"]), (raw) => raw);
    expect(labels(rows).join(" | ")).not.toMatch(/custom lease/i);
  });

  it("never shows a month-to-month surcharge, offered or not", () => {
    for (const terms of [["12-Month"], ["Month-to-Month"]]) {
      const rows = listingFeeDisplayRows(surchargeListing(terms), (raw) => raw);
      expect(labels(rows).join(" | ")).not.toMatch(/month-to-month/i);
    }
  });

  it("never prints a month-to-month surcharge in the lease document", () => {
    for (const terms of [["12-Month"], ["Month-to-Month"]]) {
      const { monthly } = leaseDocumentFeeLines(surchargeListing(terms));
      expect(monthly.map((l) => l.label).join(" | ")).not.toMatch(/month-to-month/i);
    }
  });
});
