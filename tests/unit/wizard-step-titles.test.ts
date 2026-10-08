import { describe, expect, it } from "vitest";
import { createInitialRentalWizardState } from "@/lib/rental-application/state";
import { RENTAL_WIZARD_STEP_COUNT } from "@/lib/rental-application/types";
import { RENTAL_WIZARD_STEP_TITLES, rentalWizardStepTitle } from "@/lib/rental-application/wizard-step-titles";

describe("rentalWizardStepTitle", () => {
  it("is a seven-step application", () => {
    expect(RENTAL_WIZARD_STEP_COUNT).toBe(7);
    expect(RENTAL_WIZARD_STEP_TITLES).toHaveLength(7);
  });

  it("opens with the lease", () => {
    const form = createInitialRentalWizardState();
    expect(rentalWizardStepTitle(1, form)).toBe("Your lease");
  });

  it("opens with the lease for a primary applicant too", () => {
    const form = { ...createInitialRentalWizardState(), applicantRole: "signer" as const };
    expect(rentalWizardStepTitle(1, form)).toBe("Your lease");
  });

  it("names every step", () => {
    const form = createInitialRentalWizardState();
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => rentalWizardStepTitle(n, form))).toEqual([
      "Your lease",
      "About you",
      "Where you live",
      "Work and income",
      "References",
      "More details",
      "Review, sign and pay",
    ]);
    expect(rentalWizardStepTitle(8, form)).toBe("");
  });
});
