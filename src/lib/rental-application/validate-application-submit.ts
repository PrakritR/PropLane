import type { MockProperty } from "@/data/types";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { normalizeCustomApplicationFields } from "@/lib/manager-listing-submission";
import {
  applicationConfigForVariant,
  isWizardFormFieldEnabled,
  listingDisabledWizardFormKeys,
  resolveListingApplicationFields,
  type ApplicationFormVariant,
} from "@/lib/rental-application/application-field-catalog";
import { listingCustomApplicationFields } from "@/lib/rental-application/custom-fields";
import { IN_PROGRESS_APPLICATION_STAGE } from "@/lib/rental-application/in-progress-application";
import { createInitialRentalWizardState } from "@/lib/rental-application/state";
import type { RentalWizardErrors, RentalWizardFormState } from "@/lib/rental-application/types";
import { countValidationErrors, validateRentalWizardStep } from "@/lib/rental-application/validate";

/**
 * Every non-payment step that can carry applicant-entered content.
 *
 * Keep the client submit gate and the server persistence gate on this shared
 * list. Step 11 is intentionally excluded: payment is verified by its own
 * server routes, while application-answer validation must not depend on a
 * browser-side payment snapshot.
 */
export const SUBMIT_VALIDATION_STEPS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

function mergeApplicationForm(application: Partial<RentalWizardFormState>): RentalWizardFormState {
  return { ...createInitialRentalWizardState(), ...application };
}

function listingSubmissionFromProperty(
  property: Pick<MockProperty, "listingSubmission"> | null | undefined,
): ManagerListingSubmissionV1 | undefined {
  return property?.listingSubmission?.v === 1 ? property.listingSubmission : undefined;
}

function hasFilledWizardValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.trim().length > 0;
  // Photo-attachment fields: an empty list / null slot is unfilled, so a
  // disabled income-proof or ID-photo field with no upload is not flagged.
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

export function isInProgressApplicationStage(stage: string | undefined | null): boolean {
  return stage?.trim().toLowerCase() === IN_PROGRESS_APPLICATION_STAGE.toLowerCase();
}

function variantForForm(form: Partial<RentalWizardFormState> | null | undefined): ApplicationFormVariant {
  return form?.rentalType === "short_term" ? "short_term" : "standard";
}

export function findDisabledApplicationFieldViolation(
  application: Partial<RentalWizardFormState>,
  sub: ManagerListingSubmissionV1 | null | undefined,
): string | null {
  const disabled = listingDisabledWizardFormKeys(applicationConfigForVariant(sub, variantForForm(application)));
  for (const key of disabled) {
    const value = application[key as keyof RentalWizardFormState];
    if (hasFilledWizardValue(value)) {
      return "This listing does not accept one or more submitted application fields.";
    }
  }
  return null;
}

export function sanitizeApplicationFormForListing(
  form: RentalWizardFormState,
  sub: ManagerListingSubmissionV1 | null | undefined,
): RentalWizardFormState {
  const slice = applicationConfigForVariant(sub, variantForForm(form));
  const disabled = listingDisabledWizardFormKeys(slice);
  const askedCustomKeys = sub ? new Set(listingCustomApplicationFields(slice).map((f) => f.key)) : null;
  const answers = Array.isArray(form.customFieldAnswers) ? form.customFieldAnswers : [];
  const keptAnswers = askedCustomKeys ? answers.filter((a) => askedCustomKeys.has(a.key)) : answers;
  if (disabled.size === 0 && keptAnswers.length === answers.length) return form;
  const next: RentalWizardFormState = { ...form, customFieldAnswers: keptAnswers };
  for (const key of disabled) {
    if (!(key in next)) continue;
    const current = next[key as keyof RentalWizardFormState];
    if (typeof current === "boolean") {
      (next as Record<string, unknown>)[key] = false;
      continue;
    }
    if (current === "yes" || current === "no") {
      (next as Record<string, unknown>)[key] = null;
      continue;
    }
    // Photo-attachment fields (idPhotoFront/idPhotoBack single, incomeProofPhotos
    // list). Reset to their empty shape so a short-term submission never carries
    // an ID photo (or income proof) that only the long-term form asked for. The
    // bytes in storage are reclaimed by the applicant remove/retake path and the
    // application delete cleanup — this strip is what keeps the SUBMISSION clean.
    if (Array.isArray(current)) {
      (next as Record<string, unknown>)[key] = [];
      continue;
    }
    if (current !== null && typeof current === "object") {
      (next as Record<string, unknown>)[key] = null;
      continue;
    }
    if (typeof current === "string") {
      (next as Record<string, unknown>)[key] = "";
    }
  }
  return next;
}

export function residentApplicationScreeningAllowed(
  sub: ManagerListingSubmissionV1 | null | undefined,
  form: RentalWizardFormState | null | undefined,
): boolean {
  return (
    isWizardFormFieldEnabled(applicationConfigForVariant(sub, variantForForm(form)), "consentCredit") &&
    form?.consentCredit === true
  );
}

export type ValidateResidentApplicationSubmitResult =
  | { ok: true }
  | { ok: false; error: string; step?: number; fieldErrors: RentalWizardErrors };

export function validateResidentApplicationSubmit(input: {
  application: Partial<RentalWizardFormState>;
  property?: Pick<MockProperty, "id" | "listingSubmission"> | null;
  inProgress: boolean;
}): ValidateResidentApplicationSubmitResult {
  // Drafts deliberately preserve answers while an applicant moves between
  // variants. Full validation (and disabled-field rejection) belongs at the
  // submitted-state boundary, not on each autosave keystroke.
  if (input.inProgress) return { ok: true };

  const sub = listingSubmissionFromProperty(input.property);
  const disabledViolation = findDisabledApplicationFieldViolation(input.application, sub);
  if (disabledViolation) {
    return {
      ok: false,
      error: disabledViolation,
      fieldErrors: { _general: disabledViolation },
    };
  }

  void resolveListingApplicationFields(sub, normalizeCustomApplicationFields);
  const form = mergeApplicationForm(input.application);
  for (const step of SUBMIT_VALIDATION_STEPS) {
    const errors = validateRentalWizardStep(step, form, { property: input.property ?? undefined });
    if (countValidationErrors(errors) > 0) {
      const message =
        errors._general ??
        Object.values(errors).find((value): value is string => typeof value === "string" && value.length > 0) ??
        "Application validation failed.";
      return { ok: false, error: message, step, fieldErrors: errors };
    }
  }
  return { ok: true };
}
