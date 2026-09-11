import { describe, expect, it } from "vitest";
import { validateListingWizardStep } from "@/lib/listing-wizard-validation";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import {
  LISTING_PROCESSING_FEE_WAIVER_CODE_REQUIRED,
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

  // PRP-463: the code authorises PropLane absorb for a LISTING, on every plan. An
  // account-wide entitlement is not the same as choosing it for this listing, so the tier
  // is not consulted — asking only the unentitled was the earlier, narrower rule.
  it("asks for the waive code whenever PropLane absorb is picked, on any plan", () => {
    for (const tier of ["free", "pro", "business"] as const) {
      for (const granted of [true, false]) {
        expect(listingProplaneAbsorbNeedsWaiverCode(tier, "proplane", granted)).toBe(true);
      }
    }
    // Never for the other two payers, on any plan.
    expect(listingProplaneAbsorbNeedsWaiverCode("free", "resident", false)).toBe(false);
    expect(listingProplaneAbsorbNeedsWaiverCode("pro", "manager", true)).toBe(false);
    expect(listingProplaneAbsorbNeedsWaiverCode("free", null, false)).toBe(false);
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

describe("listing wizard pricing — service fee payer", () => {
  const proplaneSub = (waiverCode?: string) => ({
    ...createDefaultListingSubmission(),
    listingPlaceCategoryId: "individual_rooms",
    allowedLeaseTerms: ["12_month"],
    serviceFeePayer: "proplane" as const,
    serviceFeeWaiverCode: waiverCode,
  });

  // PRP-463 replaced the plan gate with a code gate. What a plan buys you is
  // account-wide absorb; choosing it for ONE listing is authorised by the code, and by
  // nothing else — so a Pro account with no code is refused exactly like a Free one.
  it("refuses PropLane absorb without a valid waive code, on every plan", () => {
    for (const tier of ["free", "pro"] as const) {
      for (const granted of [true, false]) {
        const errors = validateListingWizardStep(4, proplaneSub(), {
          managerSkuTier: tier,
          accountPaymentWaiverGranted: granted,
        });
        expect(errors.serviceFeeWaiverCode).toBe(LISTING_PROCESSING_FEE_WAIVER_CODE_REQUIRED);
      }
    }
  });

  it("refuses a code that is not the waive code", () => {
    const errors = validateListingWizardStep(4, proplaneSub("NOPE"), {
      managerSkuTier: "pro",
      accountPaymentWaiverGranted: true,
    });
    expect(errors.serviceFeeWaiverCode).toBe(LISTING_PROCESSING_FEE_WAIVER_CODE_REQUIRED);
  });

  it("allows PropLane absorb with the waive code, even on Free with no grant", () => {
    const errors = validateListingWizardStep(4, proplaneSub("FREE100"), {
      managerSkuTier: "free",
      accountPaymentWaiverGranted: false,
    });
    expect(errors.serviceFeeWaiverCode).toBeUndefined();
    expect(errors.serviceFeePayer).toBeUndefined();
  });

  it("asks for nothing when the resident or the manager pays", () => {
    for (const payer of ["resident", "manager"] as const) {
      const errors = validateListingWizardStep(
        4,
        { ...createDefaultListingSubmission(), listingPlaceCategoryId: "individual_rooms", allowedLeaseTerms: ["12_month"], serviceFeePayer: payer },
        { managerSkuTier: "free", accountPaymentWaiverGranted: false },
      );
      expect(errors.serviceFeeWaiverCode).toBeUndefined();
      expect(errors.serviceFeePayer).toBeUndefined();
    }
  });
});
