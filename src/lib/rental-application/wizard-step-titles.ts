import type { RentalWizardFormState } from "./types";

export const RENTAL_WIZARD_STEP_TITLES = [
  "Which lease are you applying for?",
  "Signer Information",
  "Move-in dates",
  "Current Address",
  "Previous Address",
  "Employment and Income",
  "References",
  "Additional Details",
  "Consent and Signature",
  "Review",
  "Application fee",
] as const;

/** Step header copy. Step 1 always opens with the lease question (the lease type and room or home drive the form, the fee and the lease). */
export function rentalWizardStepTitle(step: number, _form: RentalWizardFormState): string {
  return RENTAL_WIZARD_STEP_TITLES[step - 1] ?? "";
}
