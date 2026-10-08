/**
 * The 7-step application: Your lease, About you, Where you live, Work and income, References, More details,
 * Review, sign and pay. These cover the pieces that decide what each step asks (lease type and length options per
 * property, the previous-address rule), where an error lands, and that a property can only be applied to with a
 * term it offers.
 */
import { describe, expect, it } from "vitest";
import type { MockProperty } from "@/data/types";
import { createDefaultListingSubmission, normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { RENTAL_APPLICATION_SECTIONS } from "@/lib/rental-application/application-sections";
import {
  CUSTOM_DATES_LENGTH_VALUE,
  MONTH_TO_MONTH_LENGTH_VALUE,
  defaultStoredTermForKind,
  effectiveLeaseKind,
  leaseKindPatch,
  leaseKindsOffered,
  leaseLengthLabel,
  lengthPatch,
  lengthValueFromForm,
  longTermHasImplicitMoveOut,
  longTermLengthOptions,
  showLeaseKindToggle,
  storedTermForLength,
} from "@/lib/rental-application/lease-choice";
import { previousAddressApplies, previousAddressRequired } from "@/lib/rental-application/previous-address";
import { createInitialRentalWizardState } from "@/lib/rental-application/state";
import { RENTAL_WIZARD_STEP_COUNT } from "@/lib/rental-application/types";
import { validateRentalWizardStep } from "@/lib/rental-application/validate";
import { SUBMIT_VALIDATION_STEPS } from "@/lib/rental-application/validate-application-submit";
import { RENTAL_WIZARD_STEP_FIELD_ORDER } from "@/lib/wizard-field-errors";

const LONG = ["Long-term"];
const LONG_M2M = ["Long-term", "Month-to-Month"];
const LONG_SHORT = ["Long-term", "Short-Term Stay"];
const ALL = ["Long-term", "Month-to-Month", "Custom", "Short-Term Stay"];

describe("the step map", () => {
  it("is seven steps, and every section lands on one of them", () => {
    expect(RENTAL_WIZARD_STEP_COUNT).toBe(7);
    expect([...SUBMIT_VALIDATION_STEPS]).toEqual([1, 2, 3, 4, 5, 6, 7]);
    for (const section of RENTAL_APPLICATION_SECTIONS) {
      expect(section.wizardStep).toBeGreaterThanOrEqual(1);
      expect(section.wizardStep).toBeLessThanOrEqual(RENTAL_WIZARD_STEP_COUNT);
    }
  });

  it("field errors jump to the step that owns the field", () => {
    expect(Object.keys(RENTAL_WIZARD_STEP_FIELD_ORDER).map(Number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const stepOf = (field: string) =>
      Number(Object.entries(RENTAL_WIZARD_STEP_FIELD_ORDER).find(([, fields]) => fields.includes(field))?.[0]);
    // The dates moved up into Your lease.
    for (const field of ["propertyId", "leaseTerm", "leaseStart", "leaseEnd", "shortTermCheckInTime", "shortTermRulesAck", "roomChoice1"]) {
      expect(stepOf(field), field).toBe(1);
    }
    expect(stepOf("fullLegalName")).toBe(2);
    expect(stepOf("currentStreet")).toBe(3);
    expect(stepOf("prevStreet")).toBe(3);
    expect(stepOf("employer")).toBe(4);
    expect(stepOf("ref1Name")).toBe(5);
    expect(stepOf("occupancyCount")).toBe(6);
    expect(stepOf("digitalSignature")).toBe(7);
  });

  it("every field a step can fail on is one the screen scrolls to", () => {
    const blank = { ...createInitialRentalWizardState(), applyingAsGroup: "no" as const, hasCosigner: "no" as const };
    const errors = validateRentalWizardStep(1, blank);
    for (const key of Object.keys(errors)) {
      expect(RENTAL_WIZARD_STEP_FIELD_ORDER[1], key).toContain(key);
    }
    // The signature belongs to the last step.
    const last = validateRentalWizardStep(7, blank);
    expect(Object.keys(last)).toEqual(expect.arrayContaining(["consentCredit", "consentTruth", "digitalSignature"]));
    for (const key of Object.keys(last)) expect(RENTAL_WIZARD_STEP_FIELD_ORDER[7], key).toContain(key);
  });
});

describe("which sides and lengths each property offers", () => {
  it("shows the Long-term / Short-term toggle only when the property offers both", () => {
    expect(showLeaseKindToggle(LONG)).toBe(false);
    expect(showLeaseKindToggle(LONG_M2M)).toBe(false);
    expect(showLeaseKindToggle(["Short-Term Stay"])).toBe(false);
    expect(showLeaseKindToggle(LONG_SHORT)).toBe(true);
    expect(showLeaseKindToggle(ALL)).toBe(true);
    expect(showLeaseKindToggle(["Airbnb", "Custom"])).toBe(true);
    expect(leaseKindsOffered(["12-Month"])).toMatchObject({ long: true, short: false, longTerm: true });
  });

  it("lists the fixed lengths, Custom dates, and Month-to-month only when it is on", () => {
    const labels = (offered: string[], lengths: number[]) => longTermLengthOptions(offered, lengths).map((o) => o.label);
    // Custom dates is a checkbox under Long-term: offered only when the property ticked it. A Long-term
    // property with no fixed lengths and no Custom dates still asks for a move-out date (never a dead end).
    expect(labels(LONG, [])).toEqual(["Custom dates"]);
    expect(longTermHasImplicitMoveOut(LONG, [])).toBe(true);
    expect(labels(LONG, [6, 12])).toEqual(["6 months", "12 months"]);
    expect(longTermHasImplicitMoveOut(LONG, [6, 12])).toBe(false);
    expect(labels([...LONG, "Custom"], [6, 12])).toEqual(["6 months", "12 months", "Custom dates"]);
    expect(labels([...LONG, "Month-to-Month"], [6, 12])).toEqual(["6 months", "12 months", "Month-to-month"]);
    expect(labels([...LONG, "Custom", "Month-to-Month"], [1, 12])).toEqual(["1 month", "12 months", "Custom dates", "Month-to-month"]);
    // Month-to-month off: it is never offered, whatever else the property has.
    expect(labels(LONG_SHORT, [6])).not.toContain("Month-to-month");
    // Lengths belong to Long-term: a property offering only Custom has none.
    expect(labels(["Custom"], [6, 12])).toEqual(["Custom dates"]);
    expect(labels(["Month-to-Month"], [6])).toEqual(["Month-to-month"]);
  });

  it("with short stays off there is no Short-term side at all", () => {
    expect(leaseKindsOffered(LONG_M2M).short).toBe(false);
    expect(effectiveLeaseKind({ leaseTerm: "", rentalType: "standard" }, LONG_M2M)).toBe("long");
    // With short stays on and nothing picked yet, the applicant has to choose.
    expect(effectiveLeaseKind({ leaseTerm: "", rentalType: "standard" }, LONG_SHORT)).toBeNull();
    expect(effectiveLeaseKind({ leaseTerm: "Short-Term Stay", rentalType: "short_term" }, LONG_SHORT)).toBe("short");
    expect(effectiveLeaseKind({ leaseTerm: "12-Month", rentalType: "standard" }, LONG_SHORT)).toBe("long");
  });
});

describe("what each choice stores", () => {
  it("keeps the stored values: Long-term, Short-Term Stay, Custom, Month-to-Month", () => {
    expect(defaultStoredTermForKind("long", ALL)).toBe("Long-term");
    expect(defaultStoredTermForKind("short", ALL)).toBe("Short-Term Stay");
    expect(defaultStoredTermForKind("short", ["Long-term", "Airbnb"])).toBe("Airbnb");
    expect(defaultStoredTermForKind("long", ["Custom"])).toBe("Custom");
    expect(defaultStoredTermForKind("long", ["Month-to-Month"])).toBe("Month-to-Month");
    expect(defaultStoredTermForKind("long", ["12-Month"])).toBe("12-Month");
    expect(storedTermForLength("m:12", ALL)).toBe("Long-term");
    expect(storedTermForLength(MONTH_TO_MONTH_LENGTH_VALUE, ALL)).toBe("Month-to-Month");
  });

  it("Custom dates is Custom when the property offers it, else a Long-term lease with a move-out date", () => {
    expect(storedTermForLength(CUSTOM_DATES_LENGTH_VALUE, ALL)).toBe("Custom");
    expect(storedTermForLength(CUSTOM_DATES_LENGTH_VALUE, LONG_M2M)).toBe("Long-term");
    expect(storedTermForLength(CUSTOM_DATES_LENGTH_VALUE, ["Custom"])).toBe("Custom");
  });

  it("switching sides clears only the dates and writes the stay type with the term", () => {
    expect(leaseKindPatch("short", ALL)).toEqual({ leaseTerm: "Short-Term Stay", rentalType: "short_term", leaseStart: "", leaseEnd: "" });
    expect(leaseKindPatch("long", ALL)).toEqual({ leaseTerm: "Long-term", rentalType: "standard", leaseStart: "", leaseEnd: "" });
    // Nothing about the property or rooms is in the patch.
    expect(Object.keys(leaseKindPatch("short", ALL)).sort()).toEqual(["leaseEnd", "leaseStart", "leaseTerm", "rentalType"]);
  });

  it("a fixed length fills the end date from the move-in date; month-to-month has none", () => {
    expect(lengthPatch("m:6", ALL, "2099-01-01")).toEqual({ leaseTerm: "Long-term", leaseEnd: "2099-06-30" });
    expect(lengthPatch("m:12", ALL, "2099-03-15")).toEqual({ leaseTerm: "Long-term", leaseEnd: "2100-03-14" });
    expect(lengthPatch("m:6", ALL, "")).toEqual({ leaseTerm: "Long-term", leaseEnd: "" });
    expect(lengthPatch(MONTH_TO_MONTH_LENGTH_VALUE, ALL, "2099-01-01")).toEqual({ leaseTerm: "Month-to-Month", leaseEnd: "" });
  });

  it("reads the Length back from what is stored", () => {
    const lengths = [6, 12];
    const read = (leaseTerm: string, leaseStart: string, leaseEnd: string, customPicked = false) =>
      lengthValueFromForm({ leaseTerm, leaseStart, leaseEnd }, lengths, customPicked);
    expect(read("Long-term", "2099-01-01", "2099-06-30")).toBe("m:6");
    expect(read("Long-term", "2099-01-01", "2099-03-04")).toBe(CUSTOM_DATES_LENGTH_VALUE);
    expect(read("Long-term", "2099-01-01", "")).toBe("");
    expect(read("Long-term", "2099-01-01", "", true)).toBe(CUSTOM_DATES_LENGTH_VALUE);
    expect(read("Custom", "", "")).toBe(CUSTOM_DATES_LENGTH_VALUE);
    expect(read("Month-to-Month", "2099-01-01", "")).toBe(MONTH_TO_MONTH_LENGTH_VALUE);
    expect(read("12-Month", "2099-01-01", "2099-12-31")).toBe("m:12");
    expect(read("Short-Term Stay", "2099-01-01", "2099-01-05")).toBe("");
    expect(leaseLengthLabel({ leaseTerm: "Long-term", leaseStart: "2099-01-01", leaseEnd: "2099-06-30" }, lengths)).toBe("6 months");
    expect(leaseLengthLabel({ leaseTerm: "Short-Term Stay", leaseStart: "2099-01-01", leaseEnd: "2099-01-05" }, lengths)).toBe("");
  });
});

describe("a term the property does not offer is still refused", () => {
  const listing = (terms: string[], shortStays = false) => {
    const sub = createDefaultListingSubmission();
    sub.allowedLeaseTerms = terms;
    sub.shortTermRentalsAllowed = shortStays;
    const property: Pick<MockProperty, "id" | "listingSubmission"> = {
      id: "prop-seven",
      listingSubmission: normalizeManagerListingSubmissionV1(sub),
    };
    return property;
  };
  const form = (leaseTerm: string, rentalType: "standard" | "short_term" = "standard") => ({
    ...createInitialRentalWizardState(),
    propertyId: "prop-seven",
    leaseTerm,
    rentalType,
    leaseStart: "2099-01-01",
    leaseEnd: leaseTerm === "Month-to-Month" ? "" : "2099-12-31",
  });
  const refused = "This lease term is not offered for the selected property.";

  it("Month-to-month and Custom are refused unless on; Long-term and the retired lengths always read", () => {
    expect(validateRentalWizardStep(1, form("Month-to-Month"), { property: listing(LONG) }).leaseTerm).toBe(refused);
    expect(validateRentalWizardStep(1, form("Month-to-Month"), { property: listing(LONG_M2M) }).leaseTerm).toBeUndefined();
    expect(validateRentalWizardStep(1, form("Custom"), { property: listing(LONG) }).leaseTerm).toBe(refused);
    expect(validateRentalWizardStep(1, form("Custom"), { property: listing(["Long-term", "Custom"]) }).leaseTerm).toBeUndefined();
    expect(validateRentalWizardStep(1, form("12-Month"), { property: listing(LONG) }).leaseTerm).toBeUndefined();
  });

  it("Short-term is refused unless the property allows short stays", () => {
    expect(validateRentalWizardStep(1, form("Short-Term Stay", "short_term"), { property: listing(LONG, false) }).leaseTerm).toBeTruthy();
    expect(validateRentalWizardStep(1, form("Short-Term Stay", "short_term"), { property: listing(LONG, true) }).leaseTerm).toBeUndefined();
  });

  it("a missing date is an error on step 1, and none of the later steps asks for it", () => {
    const noDates = { ...form("Long-term"), leaseStart: "", leaseEnd: "" };
    const errors = validateRentalWizardStep(1, noDates, { property: listing(LONG) });
    expect(errors.leaseStart).toBeTruthy();
    expect(errors.leaseEnd).toBeTruthy();
    for (const step of [2, 3, 4, 5, 6, 7]) {
      const later = validateRentalWizardStep(step, noDates, { property: listing(LONG) });
      expect(later.leaseStart, `step ${step}`).toBeUndefined();
      expect(later.leaseEnd, `step ${step}`).toBeUndefined();
    }
  });
});

describe("Where you live: the previous address is only asked under two years", () => {
  const today = new Date(2026, 9, 8);

  it("applies when the move-in date is unknown or under two years ago", () => {
    expect(previousAddressApplies({ currentMoveIn: "" }, today)).toBe(true);
    expect(previousAddressApplies({ currentMoveIn: "2026-01-01" }, today)).toBe(true);
    expect(previousAddressApplies({ currentMoveIn: "2024-10-09" }, today)).toBe(true);
  });

  it("does not apply at two years or more", () => {
    expect(previousAddressApplies({ currentMoveIn: "2024-10-08" }, today)).toBe(false);
    expect(previousAddressApplies({ currentMoveIn: "2019-05-01" }, today)).toBe(false);
  });

  it("is only required when it applies and the applicant has not said there is none", () => {
    expect(previousAddressRequired({ currentMoveIn: "2026-01-01", noPreviousAddress: false }, today)).toBe(true);
    expect(previousAddressRequired({ currentMoveIn: "2026-01-01", noPreviousAddress: true }, today)).toBe(false);
    expect(previousAddressRequired({ currentMoveIn: "2019-05-01", noPreviousAddress: false }, today)).toBe(false);
  });

  it("step 3 validates the previous address only when it is asked", () => {
    const base = {
      ...createInitialRentalWizardState(),
      currentStreet: "1 Main St",
      currentCity: "Seattle",
      currentState: "WA",
      currentZip: "98101",
    };
    const recent = { ...base, currentMoveIn: new Date().toISOString().slice(0, 10) };
    expect(validateRentalWizardStep(3, recent).prevStreet).toBeTruthy();
    expect(validateRentalWizardStep(3, { ...recent, noPreviousAddress: true }).prevStreet).toBeUndefined();
    const settled = { ...base, currentMoveIn: "2015-01-01" };
    const errors = validateRentalWizardStep(3, settled);
    expect(errors.prevStreet).toBeUndefined();
    expect(errors.prevCity).toBeUndefined();
    expect(errors.prevState).toBeUndefined();
    expect(errors.prevZip).toBeUndefined();
  });
});

describe("a co-signer cannot switch off the lease checks (security review, Oct 8)", () => {
  it("step 1 still validates the property, lease term and dates when applicantRole is cosigner", () => {
    const cosigner = { ...createInitialRentalWizardState(), applicantRole: "cosigner" as const };
    const errors = validateRentalWizardStep(1, cosigner);
    expect(Object.keys(errors).length).toBeGreaterThan(0);
    // The same lease-choice errors an applicant gets, so a forged role cannot submit an unoffered term.
    const applicant = validateRentalWizardStep(1, { ...createInitialRentalWizardState() });
    for (const key of Object.keys(errors)) expect(applicant).toHaveProperty(key);
  });
});
