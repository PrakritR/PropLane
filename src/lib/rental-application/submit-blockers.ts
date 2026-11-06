import { RENTAL_WIZARD_STEP_FIELD_ORDER } from "@/lib/wizard-field-errors";
import { RENTAL_WIZARD_STEP_COUNT } from "@/lib/rental-application/types";
import { RENTAL_WIZARD_STEP_TITLES } from "@/lib/rental-application/wizard-step-titles";

export type WizardSubmitBlocker = { message: string; step?: number };

/** The step whose screen owns a field, so a refusal can link the applicant to where it is fixed. */
export function wizardStepOfField(field: string, fallback = 1): number {
  for (let n = 1; n <= RENTAL_WIZARD_STEP_COUNT; n += 1) {
    if (RENTAL_WIZARD_STEP_FIELD_ORDER[n]?.includes(field)) return n;
  }
  return fallback;
}

/** One blocker per refused field: "Work and income: Monthly income is required." with the step to fix it on. */
export function wizardSubmitBlockersFromFieldErrors(
  fieldErrors: Record<string, string> | undefined,
  fallbackStep = 1,
): WizardSubmitBlocker[] {
  const out: WizardSubmitBlocker[] = [];
  for (const [field, raw] of Object.entries(fieldErrors ?? {})) {
    const message = String(raw ?? "").trim();
    if (!message) continue;
    const step = wizardStepOfField(field, fallbackStep);
    const title = RENTAL_WIZARD_STEP_TITLES[step - 1];
    out.push({ message: title ? `${title}: ${message}` : message, step });
  }
  return out.sort((a, b) => (a.step ?? 0) - (b.step ?? 0));
}
