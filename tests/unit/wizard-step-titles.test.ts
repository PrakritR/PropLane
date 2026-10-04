import { describe, expect, it } from "vitest";
import { createInitialRentalWizardState } from "@/lib/rental-application/state";
import { rentalWizardStepTitle } from "@/lib/rental-application/wizard-step-titles";

describe("rentalWizardStepTitle", () => {
  it("opens with the lease question", () => {
    const form = createInitialRentalWizardState();
    expect(rentalWizardStepTitle(1, form)).toBe("Which lease are you applying for?");
  });

  it("asks the lease question of a primary applicant too", () => {
    const form = { ...createInitialRentalWizardState(), applicantRole: "signer" as const };
    expect(rentalWizardStepTitle(1, form)).toBe("Which lease are you applying for?");
  });

  it("keeps later step titles unchanged", () => {
    const form = createInitialRentalWizardState();
    expect(rentalWizardStepTitle(3, form)).toBe("Move-in dates");
  });
});
