import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { DemoApplicantRow } from "@/data/demo-portal";
import type { MockProperty } from "@/data/types";
import { isDraftApplicationRow } from "@/lib/manager-applications-storage";
import type { RentalWizardErrors } from "@/lib/rental-application/types";
import {
  validateResidentApplicationSubmit,
  type ValidateResidentApplicationSubmitResult,
} from "@/lib/rental-application/validate-application-submit";
import {
  applyEffectiveApplicationForm,
  normalizeWorkspaceApplicationFormTemplate,
} from "@/lib/rental-application/workspace-application-form";

export type ServerApplicationValidationResult =
  | { ok: true }
  | {
      ok: false;
      status: 400 | 422 | 500;
      error: string;
      step?: number;
      fieldErrors: RentalWizardErrors;
    };

function propertyIdForApplication(row: DemoApplicantRow): string {
  return (
    row.propertyId?.trim() ||
    row.assignedPropertyId?.trim() ||
    row.application?.propertyId?.trim() ||
    ""
  );
}

function asValidationProperty(value: unknown, propertyId: string): MockProperty | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return { ...(value as MockProperty), id: propertyId };
}

/**
 * The listing as the applicant was shown it: the stored property with the workspace's effective application
 * form applied. The submit validator and Quick apply both read the questions from THIS, so what is asked and
 * what is required can never differ between them.
 */
export type EffectiveApplicationPropertyRead =
  | { ok: true; property: MockProperty | null }
  | { ok: false; readFailed: true };

/** How a caller reads the listing. Always the database — the only choice is whether it is read again. */
export type EffectiveApplicationPropertyLoader = (propertyId: string) => Promise<EffectiveApplicationPropertyRead>;

export async function loadEffectiveApplicationProperty(
  db: SupabaseClient,
  propertyId: string,
): Promise<EffectiveApplicationPropertyRead> {
  let property: MockProperty | null = null;
  if (propertyId) {
    const { data, error } = await db
      .from("manager_property_records")
      .select("property_data, workspace_id")
      .eq("id", propertyId)
      .maybeSingle();
    if (error) {
      return { ok: false, readFailed: true };
    }
    property = asValidationProperty(data?.property_data, propertyId);
    // Same effective-form resolution as the public payload the applicant
    // actually saw (`publicListingProjection`) — required-ness for a
    // question served from the workspace template must be enforced here
    // exactly as it was rendered, never re-derived from the listing's own
    // (possibly different) triplet alone.
    if (property?.listingSubmission?.v === 1 && data?.workspace_id) {
      // Best-effort: this lookup only refines which questions are required.
      // A failure here (missing table in an environment mid-migration, a
      // narrow test double, a transient error) must never turn an otherwise
      // valid submission into a 500 — fall back to the listing's own fields,
      // exactly like `resolveEffectiveApplicationForm` already does for a
      // workspace that has genuinely never saved a template.
      try {
        const { data: workspaceRow } = await db
          .from("workspace_automation_settings")
          .select("row_data")
          .eq("workspace_id", data.workspace_id)
          .maybeSingle();
        const rowData = workspaceRow?.row_data;
        const raw =
          rowData && typeof rowData === "object" && !Array.isArray(rowData)
            ? (rowData as Record<string, unknown>).applicationFormTemplate
            : undefined;
        const workspaceForm = normalizeWorkspaceApplicationFormTemplate(raw);
        property = {
          ...property,
          listingSubmission: applyEffectiveApplicationForm(property.listingSubmission, workspaceForm),
        };
      } catch {
        /* fall back to the listing's own fields, unchanged */
      }
    }
  }

  return { ok: true, property };
}

/**
 * One read per listing for as long as the returned loader lives (one request).
 *
 * A single submit asks for the same listing two or three times — the caller's own look at the rooms and
 * questions, then the validator inside the shared write. Keyed on the listing id, so a different listing
 * still reads fresh and the answer is always the database's: this removes a round trip, never a check.
 */
export function memoizeEffectiveApplicationProperty(db: SupabaseClient): EffectiveApplicationPropertyLoader {
  const reads = new Map<string, Promise<EffectiveApplicationPropertyRead>>();
  return (propertyId: string) => {
    const key = propertyId.trim();
    const pending = reads.get(key);
    if (pending) return pending;
    const read = loadEffectiveApplicationProperty(db, key);
    reads.set(key, read);
    return read;
  };
}

/**
 * Validate an applicant-owned row immediately before persistence.
 *
 * The listing configuration is loaded from the database so required custom
 * questions and disabled standard fields cannot be forged by the request.
 * Manager/admin edits use a separate route branch and deliberately do not pass
 * through this gate, preserving their ability to repair legacy applications.
 *
 * `loadProperty` only says WHERE the already-read listing came from
 * (`memoizeEffectiveApplicationProperty`, keyed on the listing id) — never what it says.
 */
export async function validateResidentApplicationRowForPersistence(
  db: SupabaseClient,
  row: DemoApplicantRow,
  opts?: { loadProperty?: EffectiveApplicationPropertyLoader },
): Promise<ServerApplicationValidationResult> {
  if (isDraftApplicationRow(row)) return { ok: true };

  if (!row.application || typeof row.application !== "object") {
    const error = "Application answers are required before submission.";
    return {
      ok: false,
      status: 422,
      error,
      fieldErrors: { _general: error },
    };
  }

  const propertyId = propertyIdForApplication(row);
  let property: MockProperty | null = null;
  if (propertyId) {
    const loaded = await (opts?.loadProperty ?? ((id: string) => loadEffectiveApplicationProperty(db, id)))(propertyId);
    if (!loaded.ok) {
      return {
        ok: false,
        status: 500,
        error: "Could not validate the application against the listing.",
        fieldErrors: {},
      };
    }
    property = loaded.property;
  }

  if (!property) {
    const error = "This listing cannot accept applications yet.";
    return {
      ok: false,
      status: 400,
      error,
      fieldErrors: { propertyId: error },
    };
  }

  const result: ValidateResidentApplicationSubmitResult = validateResidentApplicationSubmit({
    application: row.application,
    property,
    inProgress: false,
  });
  if (result.ok) return result;
  return { ...result, status: 422 };
}
