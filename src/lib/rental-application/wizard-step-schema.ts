import { RENTAL_WIZARD_STEP_COUNT } from "./types";

/**
 * Persisted on each application with its wizard step so a saved position is read against the flow it was
 * written for. 1 (absent) = the 12-step wizard, 2 = the 11-step household-first wizard, 3 = the 7-step wizard
 * (Your lease, About you, Where you live, Work and income, References, More details, Review sign and pay).
 */
export const RENTAL_WIZARD_STEP_SCHEMA = 3;

const LEGACY_RENTAL_WIZARD_STEP_COUNT = 12;

/** Map a persisted step from the old 12-step wizard onto the 11-step flow. */
export function remapLegacyPersistedWizardStep(step: number): number {
  if (step <= 1) return 1;
  if (step === 2) return 1;
  if (step === 3) return 3;
  if (step === 4) return 2;
  if (step <= LEGACY_RENTAL_WIZARD_STEP_COUNT) return step - 1;
  return step;
}

/**
 * Where each step of the 11-step wizard (schema 2) lives in the 7-step wizard, index = old step - 1:
 * 1 lease -> 1, 2 signer -> 2, 3 dates -> 1 (dates moved up into Your lease), 4 current and 5 previous address
 * -> 3, 6 employment -> 4, 7 references -> 5, 8 additional -> 6, 9 consent, 10 review and 11 fee -> 7.
 */
export const ELEVEN_STEP_TO_SEVEN_STEP: readonly number[] = [1, 2, 1, 3, 3, 4, 5, 6, 7, 7, 7];

/** Map a persisted step from the 11-step wizard onto the current 7-step flow. */
export function remapElevenStepPersistedWizardStep(step: number): number {
  if (step < 1) return 1;
  return ELEVEN_STEP_TO_SEVEN_STEP[step - 1] ?? RENTAL_WIZARD_STEP_COUNT;
}

export function normalizePersistedWizardStep(
  rawStep: unknown,
  schema: unknown,
): number | null {
  const parsed = typeof rawStep === "number" ? rawStep : Number.parseInt(String(rawStep ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return null;
  const floored = Math.floor(parsed);
  let step: number;
  if (schema === RENTAL_WIZARD_STEP_SCHEMA) {
    step = floored;
  } else if (schema === 2) {
    if (floored > ELEVEN_STEP_TO_SEVEN_STEP.length) return null;
    step = remapElevenStepPersistedWizardStep(floored);
  } else {
    const eleven = remapLegacyPersistedWizardStep(floored);
    if (eleven > ELEVEN_STEP_TO_SEVEN_STEP.length) return null;
    step = remapElevenStepPersistedWizardStep(eleven);
  }
  if (step < 1 || step > RENTAL_WIZARD_STEP_COUNT) return null;
  return step;
}
