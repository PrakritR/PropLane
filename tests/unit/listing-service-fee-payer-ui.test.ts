import { describe, expect, it } from "vitest";
import { validateListingWizardStep } from "@/lib/listing-wizard-validation";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import {
  listingPaymentWaiverCodeMatches,
  listingProplaneAbsorbNeedsWaiverCode,
  listingServiceFeePayerUiValue,
  managerCanSelectManagerAbsorbServiceFee,
  managerCanSelectProplaneServiceFee,
} from "@/lib/payment-policy";

describe("listing service fee payer UI helpers", () => {
  it("allows PropLane absorb on paid plans and on Free with FREE100", () => {
    expect(managerCanSelectProplaneServiceFee("pro", false)).toBe(true);
    expect(managerCanSelectProplaneServiceFee("free", true)).toBe(true);
    expect(managerCanSelectProplaneServiceFee("free", false)).toBe(false);
  });

  it("allows manager absorb only on paid plans", () => {
    expect(managerCanSelectManagerAbsorbServiceFee("pro")).toBe(true);
    expect(managerCanSelectManagerAbsorbServiceFee("free")).toBe(false);
  });

  it("defaults unset listing values to proplane on paid and resident on Free", () => {
    expect(listingServiceFeePayerUiValue(null, "pro", false)).toBe("proplane");
    expect(listingServiceFeePayerUiValue(null, "free", false)).toBe("resident");
    expect(listingServiceFeePayerUiValue(null, "free", true)).toBe("proplane");
  });

  it("requires a per-listing waiver code on Free when PropLane absorb is selected", () => {
    expect(listingProplaneAbsorbNeedsWaiverCode("free", "proplane", false)).toBe(true);
    expect(listingProplaneAbsorbNeedsWaiverCode("free", "proplane", true)).toBe(false);
    expect(listingProplaneAbsorbNeedsWaiverCode("pro", "proplane", false)).toBe(false);
  });

  it("accepts only FREE100 as the listing waiver code", () => {
    expect(listingPaymentWaiverCodeMatches("free100")).toBe(true);
    expect(listingPaymentWaiverCodeMatches("FREE 100")).toBe(true);
    expect(listingPaymentWaiverCodeMatches("wrong")).toBe(false);
  });
});

describe("listing wizard pricing — service fee waiver", () => {
  it("blocks PropLane absorb on Free without a valid waiver code", () => {
    const sub = {
      ...createDefaultListingSubmission(),
      listingPlaceCategoryId: "individual_rooms",
      allowedLeaseTerms: ["12_month"],
      serviceFeePayer: "proplane" as const,
    };
    const errors = validateListingWizardStep(4, sub, {
      managerSkuTier: "free",
      accountPaymentWaiverGranted: false,
    });
    expect(errors.serviceFeeWaiverCode).toMatch(/FREE100/);
  });

  it("allows PropLane absorb on Free when the listing waiver code matches", () => {
    const sub = {
      ...createDefaultListingSubmission(),
      listingPlaceCategoryId: "individual_rooms",
      allowedLeaseTerms: ["12_month"],
      serviceFeePayer: "proplane" as const,
      serviceFeeWaiverCode: "FREE100",
    };
    const errors = validateListingWizardStep(4, sub, {
      managerSkuTier: "free",
      accountPaymentWaiverGranted: false,
    });
    expect(errors.serviceFeeWaiverCode).toBeUndefined();
  });
});
