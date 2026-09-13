import { describe, expect, it } from "vitest";
import { validateListingWizardStep } from "@/lib/listing-wizard-validation";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import {
  LISTING_PROCESSING_FEE_PROPLANE_NOT_ALLOWED,
  listingPaymentWaiverCodeMatches,
  listingProplaneAbsorbNeedsWaiverCode,
  listingServiceFeePayerUiValue,
  managerCanSelectManagerAbsorbServiceFee,
  managerCanSelectProplaneServiceFee,
  persistListingServiceFeePayer,
} from "@/lib/payment-policy";

describe("listing service fee payer UI helpers", () => {
  it("needs a promo grant (or staff approval) on every plan — a paid plan alone never unlocks it", () => {
    expect(managerCanSelectProplaneServiceFee("pro", false)).toBe(false);
    expect(managerCanSelectProplaneServiceFee("pro", true)).toBe(true);
    expect(managerCanSelectProplaneServiceFee("free", true)).toBe(true);
    expect(managerCanSelectProplaneServiceFee("free", false)).toBe(false);
  });

  it("allows manager absorb only on paid plans", () => {
    expect(managerCanSelectManagerAbsorbServiceFee("pro")).toBe(true);
    expect(managerCanSelectManagerAbsorbServiceFee("free")).toBe(false);
  });

  it("defaults unset listing values to resident on every plan, grant or not", () => {
    expect(listingServiceFeePayerUiValue(null, "pro", false)).toBe("resident");
    expect(listingServiceFeePayerUiValue(null, "free", false)).toBe("resident");
    expect(listingServiceFeePayerUiValue(null, "free", true)).toBe("resident");
  });

  it("shows a stored PropLane choice only when the account may select it", () => {
    expect(listingServiceFeePayerUiValue("proplane", "pro", true)).toBe("proplane");
    expect(listingServiceFeePayerUiValue("proplane", "pro", false)).toBe("resident");
    expect(listingServiceFeePayerUiValue("manager", "free", false)).toBe("resident");
    expect(listingServiceFeePayerUiValue("manager", "pro", false)).toBe("manager");
  });

  it("asks the Pricing step for the promo code when PropLane is chosen and nothing on the account backs it", () => {
    expect(listingProplaneAbsorbNeedsWaiverCode("free", "proplane", false)).toBe(true);
    expect(listingProplaneAbsorbNeedsWaiverCode("pro", "proplane", false)).toBe(true);
    expect(listingProplaneAbsorbNeedsWaiverCode("pro", "proplane", true)).toBe(false);
    expect(listingProplaneAbsorbNeedsWaiverCode("pro", "resident", false)).toBe(false);
  });

  it("persists PropLane absorb with the promo code, an account grant, or preserved codeless proplane", () => {
    expect(persistListingServiceFeePayer("proplane", "FREE100")).toEqual({
      serviceFeePayer: "proplane",
      serviceFeeWaiverCode: "FREE100",
    });
    // The code travels with the listing even when the account is granted, so
    // checkout can re-validate it without a second lookup.
    expect(persistListingServiceFeePayer("proplane", "free 100", false)).toEqual({
      serviceFeePayer: "proplane",
      serviceFeeWaiverCode: "FREE100",
    });
    // Unknown grant status (read/normalize paths) preserves the choice; checkout decides.
    expect(persistListingServiceFeePayer("proplane", "")).toEqual({
      serviceFeePayer: "proplane",
      serviceFeeWaiverCode: undefined,
    });
    // A typo is not a grant.
    expect(persistListingServiceFeePayer("proplane", "WRONG")).toEqual({
      serviceFeePayer: "resident",
      serviceFeeWaiverCode: undefined,
    });
    expect(persistListingServiceFeePayer("proplane", "", true)).toEqual({
      serviceFeePayer: "proplane",
      serviceFeeWaiverCode: undefined,
    });
    expect(persistListingServiceFeePayer("proplane", "", false)).toEqual({
      serviceFeePayer: "resident",
      serviceFeeWaiverCode: undefined,
    });
    expect(persistListingServiceFeePayer(null, "FREE100")).toEqual({
      serviceFeePayer: null,
      serviceFeeWaiverCode: undefined,
    });
  });

  it("accepts only the shared promo code, in any casing or spacing", () => {
    expect(listingPaymentWaiverCodeMatches("free100")).toBe(true);
    expect(listingPaymentWaiverCodeMatches("FREE 100")).toBe(true);
    expect(listingPaymentWaiverCodeMatches("wrong")).toBe(false);
    expect(listingPaymentWaiverCodeMatches("")).toBe(false);
    expect(listingPaymentWaiverCodeMatches(null)).toBe(false);
  });

});

describe("listing wizard pricing — service fee payer (PRP-421)", () => {
  it("blocks PropLane absorb on Free without an account waiver", () => {
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
    expect(errors.serviceFeePayer).toBe(LISTING_PROCESSING_FEE_PROPLANE_NOT_ALLOWED);
    expect(errors.serviceFeeWaiverCode).toBeUndefined();
  });

  it("allows PropLane absorb on Free when the account already has a waiver grant", () => {
    const sub = {
      ...createDefaultListingSubmission(),
      listingPlaceCategoryId: "individual_rooms",
      allowedLeaseTerms: ["12_month"],
      serviceFeePayer: "proplane" as const,
    };
    const errors = validateListingWizardStep(4, sub, {
      managerSkuTier: "free",
      accountPaymentWaiverGranted: true,
    });
    expect(errors.serviceFeePayer).toBeUndefined();
    expect(errors.serviceFeeWaiverCode).toBeUndefined();
  });

  it("allows PropLane absorb on any plan when the listing carries the promo code", () => {
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
    expect(errors.serviceFeePayer).toBeUndefined();
  });

  it("blocks PropLane on Pro without a promo grant — a paid plan is not a grant", () => {
    const sub = {
      ...createDefaultListingSubmission(),
      listingPlaceCategoryId: "individual_rooms",
      allowedLeaseTerms: ["12_month"],
      serviceFeePayer: "proplane" as const,
    };
    const errors = validateListingWizardStep(4, sub, {
      managerSkuTier: "pro",
      accountPaymentWaiverGranted: false,
    });
    expect(errors.serviceFeePayer).toBe(LISTING_PROCESSING_FEE_PROPLANE_NOT_ALLOWED);
    expect(errors.serviceFeeWaiverCode).toBeUndefined();
  });
});
