import { describe, expect, it } from "vitest";
import { validateListingWizardStep } from "@/lib/listing-wizard-validation";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import {
  listingPaymentWaiverCodeMatches,
  listingProplaneAbsorbNeedsWaiverCode,
  listingServiceFeePayerUiValue,
  managerCanSelectManagerAbsorbServiceFee,
  managerCanSelectProplaneServiceFee,
  persistListingServiceFeePayer,
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

  it("defaults unset listing values to resident on every plan", () => {
    expect(listingServiceFeePayerUiValue(null, "pro", false)).toBe("resident");
    expect(listingServiceFeePayerUiValue(null, "free", false)).toBe("resident");
    expect(listingServiceFeePayerUiValue(null, "free", true)).toBe("resident");
  });

  it("requires a per-listing waiver code whenever PropLane absorb is selected", () => {
    expect(listingProplaneAbsorbNeedsWaiverCode("free", "proplane", false)).toBe(true);
    expect(listingProplaneAbsorbNeedsWaiverCode("free", "proplane", true)).toBe(false);
    expect(listingProplaneAbsorbNeedsWaiverCode("pro", "proplane", false)).toBe(true);
    expect(listingProplaneAbsorbNeedsWaiverCode("pro", "proplane", true)).toBe(false);
    expect(listingProplaneAbsorbNeedsWaiverCode("pro", "resident", false)).toBe(false);
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
    expect(errors.serviceFeeWaiverCode).toMatch(/waiver code PropLane gave you/i);
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
    expect(errors.serviceFeeWaiverCode).toBeUndefined();
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
