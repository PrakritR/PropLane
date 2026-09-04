import { describe, expect, it } from "vitest";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
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
