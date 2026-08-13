import { describe, expect, it } from "vitest";
import { listingWizardStepIndices } from "@/components/portal/manager-add-listing-form";
import {
  applyListingBedroomSlots,
  applyListingBathroomSlots,
  bathroomCountFromListingTotalBathroomsId,
  createDefaultListingSubmission,
  emptyBathroom,
  emptyRoom,
  emptySharedSpace,
  formatListingBasicsSummary,
  isListingFeeAmountFilled,
  resolveAllowedLeaseTerms,
  syncShortTermLeaseTermInAllowed,
} from "@/lib/manager-listing-submission";
import {
  deriveListingLtFeeToggles,
} from "@/lib/listing-fee-term-toggles";
import { SHORT_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";
import {
  firstInvalidListingStep,
  listingBathroomNameKey,
  listingSharedSpaceNameKey,
  validateListingWizardStep,
} from "@/lib/listing-wizard-validation";

function filledPricingSubmission() {
  const sub = createDefaultListingSubmission();
  sub.address = "123 Main St";
  sub.city = "Seattle";
  sub.state = "WA";
  sub.zip = "98101";
  sub.listingPropertyTypeId = "house";
  sub.listingStoriesId = "2";
  sub.listingTotalBathroomsId = "2";
  sub.listingBedroomSlots = 1;
  sub.rooms = [{ ...emptyRoom(0), id: "r1", name: "Room A", monthlyRent: 900 }];
  sub.bathrooms = [{ ...emptyBathroom(0), id: "b1", name: "Hall bath" }];
  sub.allowedLeaseTerms = ["12-Month"];
  sub.applicationFee = "50";
  sub.securityDeposit = "900";
  sub.moveInFee = "0";
  sub.parkingMonthly = "0";
  sub.hoaMonthly = "0";
  sub.otherMonthlyFees = "0";
  sub.monthToMonthSurcharge = "0";
  return sub;
}

describe("create listing wizard", () => {
  it("requires address, city, state, and valid zip on home step", () => {
    const sub = createDefaultListingSubmission();
    const errs = validateListingWizardStep(0, sub);
    expect(errs.address).toMatch(/required/i);
    expect(errs.city).toMatch(/required/i);
    expect(errs.state).toMatch(/state/i);
    expect(errs.zip).toMatch(/required/i);

    sub.address = "123 Main St";
    sub.city = "Seattle";
    sub.state = "WA";
    sub.zip = "9810";
    const zipErrs = validateListingWizardStep(0, sub);
    expect(zipErrs.zip).toMatch(/valid/i);
  });

  it("requires property setup fields on new listing home step", () => {
    const sub = createDefaultListingSubmission();
    sub.address = "123 Main St";
    sub.city = "Seattle";
    sub.state = "WA";
    sub.zip = "98101";
    const errs = validateListingWizardStep(0, sub);
    expect(errs.listingPropertyTypeId).toBeTruthy();
    expect(errs.listingStoriesId).toBeTruthy();
    expect(errs.listingTotalBathroomsId).toBeTruthy();
  });

  it("requires bedroom slots when unset on new listing home step", () => {
    const sub = createDefaultListingSubmission();
    sub.address = "123 Main St";
    sub.city = "Seattle";
    sub.state = "WA";
    sub.zip = "98101";
    sub.listingPropertyTypeId = "house";
    sub.listingStoriesId = "2";
    sub.listingTotalBathroomsId = "2";
    sub.listingBedroomSlots = 0;
    const errs = validateListingWizardStep(0, sub);
    expect(errs.listingBedroomSlots).toMatch(/bedroom/i);
  });

  it("skips property setup validation in edit mode", () => {
    const sub = createDefaultListingSubmission();
    sub.address = "123 Main St";
    sub.city = "Seattle";
    sub.state = "WA";
    sub.zip = "98101";
    const errs = validateListingWizardStep(0, sub, { isEditMode: true });
    expect(errs.listingPropertyTypeId).toBeUndefined();
    expect(errs.listingStoriesId).toBeUndefined();
  });

  it("treats bathroom and shared space names as optional on their steps", () => {
    const sub = createDefaultListingSubmission();
    sub.bathrooms = [{ ...emptyBathroom(0), id: "b1", name: "" }];
    sub.sharedSpaces = [{ ...emptySharedSpace(0), id: "s1", name: "" }];

    const bathErrs = validateListingWizardStep(2, sub);
    expect(bathErrs[listingBathroomNameKey("b1")]).toBeUndefined();

    const spaceErrs = validateListingWizardStep(3, sub);
    expect(spaceErrs[listingSharedSpaceNameKey("s1")]).toBeUndefined();
  });

  it("requires lease terms and fee fields on pricing step", () => {
    const sub = filledPricingSubmission();
    sub.allowedLeaseTerms = [];
    sub.securityDeposit = "";
    const errs = validateListingWizardStep(4, sub);
    expect(errs.allowedLeaseTerms).toMatch(/lease term/i);

    sub.allowedLeaseTerms = ["12-Month"];
    sub.securityDeposit = "";
    const feeErrs = validateListingWizardStep(4, sub, {
      ltFeeToggles: { ...deriveListingLtFeeToggles(sub), securityDeposit: true },
    });
    expect(feeErrs.securityDeposit).toMatch(/security deposit/i);
  });

  it("does NOT require an application fee on the pricing step (it is set per-manager in Application settings)", () => {
    const sub = filledPricingSubmission();
    sub.applicationFee = "";
    const errs = validateListingWizardStep(4, sub);
    expect(errs.applicationFee).toBeUndefined();
  });

  it("does not gate pricing on resident payment methods (configured in Payment setup)", () => {
    const sub = filledPricingSubmission();
    sub.axisPaymentsEnabled = false;
    sub.zellePaymentsEnabled = false;
    sub.venmoPaymentsEnabled = false;
    const errs = validateListingWizardStep(4, sub);
    expect(errs.residentPaymentMethods).toBeUndefined();
    expect(errs.zelleContact).toBeUndefined();
    expect(errs.venmoContact).toBeUndefined();
  });

  it("finds the first invalid step in order", () => {
    const sub = createDefaultListingSubmission();
    const hit = firstInvalidListingStep(sub, {});
    expect(hit?.stepIndex).toBe(0);
    expect(hit?.errors.address).toBeTruthy();
  });

  it("returns null when steps through pricing pass", () => {
    const sub = filledPricingSubmission();
    expect(firstInvalidListingStep(sub, {})).toBeNull();
  });

  it("grows and shrinks bedroom slots when rows are empty", () => {
    const sub = createDefaultListingSubmission();
    const grown = applyListingBedroomSlots(sub, 3);
    expect(grown.ok).toBe(true);
    if (grown.ok) expect(grown.sub.rooms).toHaveLength(3);

    const shrunk = applyListingBedroomSlots(grown.ok ? grown.sub : sub, 1);
    expect(shrunk.ok).toBe(true);
    if (shrunk.ok) expect(shrunk.sub.rooms).toHaveLength(1);
  });

  it("blocks shrinking bedroom slots when last room has data", () => {
    const sub = filledPricingSubmission();
    sub.listingBedroomSlots = 2;
    sub.rooms = [
      { ...emptyRoom(0), id: "r1", name: "Room A", monthlyRent: 900 },
      { ...emptyRoom(1), id: "r2", name: "Room B", monthlyRent: 800 },
    ];
    const blocked = applyListingBedroomSlots(sub, 1);
    expect(blocked.ok).toBe(false);
  });

  it("maps bathroom option ids to card counts", () => {
    expect(bathroomCountFromListingTotalBathroomsId("1.5")).toBe(2);
    expect(bathroomCountFromListingTotalBathroomsId("4+")).toBe(4);
    expect(bathroomCountFromListingTotalBathroomsId("2")).toBe(2);
  });

  it("grows and shrinks bathroom slots from home bathroom count", () => {
    const sub = createDefaultListingSubmission();
    sub.listingTotalBathroomsId = "3";
    const grown = applyListingBathroomSlots(sub);
    expect(grown.ok).toBe(true);
    if (grown.ok) {
      expect(grown.sub.bathrooms).toHaveLength(3);
      expect(grown.sub.bathrooms[0]?.name).toBeTruthy();
    }

    const shrunk = applyListingBathroomSlots(grown.ok ? grown.sub : sub, 1);
    expect(shrunk.ok).toBe(true);
    if (shrunk.ok) expect(shrunk.sub.bathrooms).toHaveLength(1);
  });

  it("blocks shrinking bathroom slots when last bathroom has data", () => {
    const sub = createDefaultListingSubmission();
    sub.listingTotalBathroomsId = "2";
    sub.bathrooms = [
      { ...emptyBathroom(0), id: "b1", name: "Hall bath" },
      { ...emptyBathroom(1), id: "b2", name: "Ensuite", location: "Room A" },
    ];
    const blocked = applyListingBathroomSlots(sub, 1);
    expect(blocked.ok).toBe(false);
  });

  it("summarizes listing basics for review", () => {
    const sub = filledPricingSubmission();
    const summary = formatListingBasicsSummary(sub);
    expect(summary).toContain("House");
    expect(summary).toContain("1 bedroom for rent");
  });
});

describe("listing fee and lease helpers", () => {
  it("treats zero as a filled fee amount", () => {
    expect(isListingFeeAmountFilled("0")).toBe(true);
    expect(isListingFeeAmountFilled("")).toBe(false);
    expect(isListingFeeAmountFilled("waived")).toBe(false);
  });

  it("resolves allowed lease terms from submission array", () => {
    const sub = createDefaultListingSubmission();
    sub.allowedLeaseTerms = ["12-Month", "Month-to-Month"];
    expect(resolveAllowedLeaseTerms(sub)).toEqual(["12-Month", "Month-to-Month"]);
  });

  it("includes short-term stay when short-term rentals are enabled", () => {
    const sub = createDefaultListingSubmission();
    sub.allowedLeaseTerms = ["12-Month"];
    sub.shortTermRentalsAllowed = true;
    expect(resolveAllowedLeaseTerms(sub)).toEqual(["12-Month", SHORT_TERM_LEASE_TERM]);
  });

  it("syncShortTermLeaseTermInAllowed adds and removes the short-term label", () => {
    expect(syncShortTermLeaseTermInAllowed(["12-Month"], true)).toEqual(["12-Month", SHORT_TERM_LEASE_TERM]);
    expect(syncShortTermLeaseTermInAllowed(["12-Month", SHORT_TERM_LEASE_TERM], false)).toEqual(["12-Month"]);
  });

  it("always lists Custom last — after Short-Term Stay — wherever lease terms are ordered", () => {
    // Custom is the escape hatch: never wedged between real terms.
    expect(syncShortTermLeaseTermInAllowed(["12-Month", "Custom"], true)).toEqual([
      "12-Month",
      SHORT_TERM_LEASE_TERM,
      "Custom",
    ]);
    expect(syncShortTermLeaseTermInAllowed(["Custom", "3-Month"], false)).toEqual(["3-Month", "Custom"]);
  });

  it("defaults holding deposit on new listings", () => {
    const sub = createDefaultListingSubmission();
    expect(sub.holdingDeposit).toBe("$100");
  });
});

describe("listing wizard scope", () => {
  it("preview scope includes marketing steps only", () => {
    expect(listingWizardStepIndices("full")).toEqual([0, 1, 2, 3, 4, 5]);
    expect(listingWizardStepIndices("preview")).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
