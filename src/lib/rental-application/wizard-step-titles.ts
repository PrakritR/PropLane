import type { RentalWizardFormState } from "./types";

export const RENTAL_WIZARD_STEP_TITLES = [
  "Your lease",
  "About you",
  "Where you live",
  "Work and income",
  "References",
  "More details",
  "Review, sign and pay",
] as const;

/** Step header copy. Step 1 always opens with the lease (property, Long-term or Short-term, dates, rooms and what you pay). */
export function rentalWizardStepTitle(step: number, _form: RentalWizardFormState): string {
  return RENTAL_WIZARD_STEP_TITLES[step - 1] ?? "";
}
