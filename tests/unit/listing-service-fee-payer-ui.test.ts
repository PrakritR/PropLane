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
  it("allows PropLane absorb on paid plans and on Free with an account waiver", () => {
    expect(managerCanSelectProplaneServiceFee("pro", false)).toBe(true);
    expect(managerCanSelectProplaneServiceFee("free", true)).toBe(true);
    expect(managerCanSelectProplaneServiceFee("free", false)).toBe(false);
  });

  it("allows manager absorb only on paid plans", () => {
    expect(managerCanSelectManagerAbsorbServiceFee("pro")).toBe(true);
    expect(managerCanSelectManagerAbsorbServiceFee("free")).toBe(false);
  });

  it("defaults unset listing values to resident on every plan", () => {
    expect(listingServiceFeePayerUiValue(null, "pro", false)).toBe("resident");
    expect(listingServiceFeePayerUiValue(null, "free", false)).toBe("resident");
    expect(listingServiceFeePayerUiValue(null, "free", true)).toBe("resident");
  });

  it("never asks the listing wizard for a FREE100 box (PRP-421)", () => {
    expect(listingProplaneAbsorbNeedsWaiverCode("free", "proplane", false)).toBe(false);
    expect(listingProplaneAbsorbNeedsWaiverCode("pro", "proplane", false)).toBe(false);
    expect(listingProplaneAbsorbNeedsWaiverCode("pro", "proplane", true)).toBe(false);
  });

  it("persists PropLane absorb with FREE100, account grant, or preserved codeless proplane", () => {
    expect(persistListingServiceFeePayer("proplane", "FREE100")).toEqual({
      serviceFeePayer: "proplane",
      serviceFeeWaiverCode: "FREE100",
    });
    expect(persistListingServiceFeePayer("proplane", "")).toEqual({
      serviceFeePayer: "proplane",
      serviceFeeWaiverCode: undefined,
    });
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

  it("accepts only FREE100 as the listing waiver code (server/storage still)", () => {
    expect(listingPaymentWaiverCodeMatches("free100")).toBe(true);
    expect(listingPaymentWaiverCodeMatches("FREE 100")).toBe(true);
    expect(listingPaymentWaiverCodeMatches("wrong")).toBe(false);
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

  it("allows PropLane absorb on Pro without any listing waiver code", () => {
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
    expect(errors.serviceFeePayer).toBeUndefined();
    expect(errors.serviceFeeWaiverCode).toBeUndefined();
  });
});
