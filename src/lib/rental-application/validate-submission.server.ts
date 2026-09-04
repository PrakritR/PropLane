import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { DemoApplicantRow } from "@/data/demo-portal";
import type { MockProperty } from "@/data/types";
import { activeApplicationWizardSteps } from "@/lib/rental-application/application-field-catalog";
import { normalizeCustomApplicationFields } from "@/lib/manager-listing-submission";
import { createInitialRentalWizardState } from "@/lib/rental-application/state";
import { countValidationErrors, validateRentalWizardStep } from "@/lib/rental-application/validate";

/**
 * Validate a SUBMITTED application server-side, against the same schema the
 * wizard uses.
 *
 * `POST /api/manager-applications` accepted the whole row from the client and
 * checked only that the id was present, that the email was the caller's, and
 * that the bucket was "pending". Nothing server-side required a name, a date of
 * birth, income, references, consent or a signature — every "required field"
 * lived in `validateRentalWizardStep`, in the browser (PRP-202).
 *
 * So a scripted or malformed submission landed in the manager's queue looking
 * legitimate, and any client bug that skipped validation persisted a half-empty
 * application permanently. This is a screening decision input: approval
 * generates charges and a lease, so trusting the browser is the wrong trust
 * boundary.
 *
 * ONE definition, not a second one that can drift — this calls the wizard's own
 * validator, over the wizard's own active step list, so the manager's required
 * CUSTOM questions are covered too.
 */
export type ApplicationValidationResult =
  | { ok: true }
  | { ok: false; errors: Record<string, string>; firstStep: number };

/** The listing shape the validator needs, read from the server's own record. */
export async function loadListingForApplicationValidation(
  db: SupabaseClient,
  propertyId: string,
): Promise<Pick<MockProperty, "id" | "listingSubmission"> | null> {
  const id = propertyId.trim();
  if (!id) return null;
  const { data } = await db
    .from("manager_property_records")
    .select("id, property_data")
    .eq("id", id)
    .maybeSingle();
  if (!data) return null;
  const propertyData =
    data.property_data && typeof data.property_data === "object" && !Array.isArray(data.property_data)
      ? (data.property_data as Record<string, unknown>)
      : null;
  const listingSubmission = propertyData?.listingSubmission;
  return {
    id: String(data.id ?? id),
    listingSubmission: listingSubmission as MockProperty["listingSubmission"],
  };
}

/**
 * `null` when the application cannot be validated at all — no wizard payload,
 * or a listing this server cannot resolve. Those are infrastructure gaps, not
 * applicant mistakes, and refusing a real submission over one would be worse
 * than the hole this closes. A payload that IS present is validated strictly.
 */
export async function validateSubmittedApplication(
  db: SupabaseClient,
  row: DemoApplicantRow,
): Promise<ApplicationValidationResult | null> {
  const submitted = row.application;
  if (!submitted) return null;

  // The validator was written for the WIZARD's state object and dereferences
  // its fields directly (`f.groupLeaderAppId.trim()`), which is safe when a
  // React form owns the shape. Here the payload arrives from the network and
  // may be any shape at all, so a partial body would throw and 500 the route
  // rather than refuse the application. Overlaying it on a complete initial
  // state is what makes the shared definition usable on this side of the wire.
  const form = { ...createInitialRentalWizardState(), ...submitted };

  const propertyId =
    (row.propertyId ?? "").trim() || (row.assignedPropertyId ?? "").trim() || (form.propertyId ?? "").trim();
  const property = await loadListingForApplicationValidation(db, propertyId);
  if (!property?.listingSubmission) return null;

  const sub = property.listingSubmission.v === 1 ? property.listingSubmission : undefined;
  // The wizard's own active steps, so a required custom question mapped to the
  // Review or Application-fee section is covered. The client used to walk a
  // hardcoded 1..9 and miss exactly those.
  const steps = activeApplicationWizardSteps(sub, normalizeCustomApplicationFields);

  for (const step of steps) {
    const errors = validateRentalWizardStep(step, form, { property });
    if (countValidationErrors(errors) > 0) {
      const cleaned: Record<string, string> = {};
      for (const [key, value] of Object.entries(errors)) {
        if (typeof value === "string" && value.trim()) cleaned[key] = value;
      }
      return { ok: false, errors: cleaned, firstStep: step };
    }
  }
  return { ok: true };
}
