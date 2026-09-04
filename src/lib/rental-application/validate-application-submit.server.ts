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
 * Validate an applicant-owned row immediately before persistence.
 *
 * The listing configuration is loaded from the database so required custom
 * questions and disabled standard fields cannot be forged by the request.
 * Manager/admin edits use a separate route branch and deliberately do not pass
 * through this gate, preserving their ability to repair legacy applications.
 */
export async function validateResidentApplicationRowForPersistence(
  db: SupabaseClient,
  row: DemoApplicantRow,
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
    const { data, error } = await db
      .from("manager_property_records")
      .select("property_data")
      .eq("id", propertyId)
      .maybeSingle();
    if (error) {
      return {
        ok: false,
        status: 500,
        error: "Could not validate the application against the listing.",
        fieldErrors: {},
      };
    }
    property = asValidationProperty(data?.property_data, propertyId);
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
