import { openApplicantRow } from "@/lib/security/applicant-identity";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoApplicantRow } from "@/data/demo-portal";
import {
  applicationRowEligibleForAutofill,
  pickAutofillProfileFromApplication,
  type ResidentApplicationAutofillProfile,
  autofillProfileIsEmpty,
} from "@/lib/rental-application/resident-application-autofill";
import { createInitialRentalWizardState } from "@/lib/rental-application/state";
import type { RentalCustomFieldAnswer } from "@/lib/rental-application/types";

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * The reusable answers from the caller's latest submitted application, plus the custom-question answers
 * that application carried (Quick apply matches them to the next listing's questions by key and type).
 */
export type ResidentApplicationAutofillBasis = {
  profile: ResidentApplicationAutofillProfile;
  customFieldAnswers: RentalCustomFieldAnswer[];
};

export async function loadResidentApplicationAutofillBasis(
  db: SupabaseClient,
  email: string,
): Promise<ResidentApplicationAutofillBasis | null> {
  const e = normalizeEmail(email);
  if (!e) return null;
  const { data, error } = await db
    .from("manager_application_records")
    .select("id, row_data, updated_at")
    .eq("resident_email", e)
    .order("updated_at", { ascending: false })
    .limit(40);
  if (error) throw error;
  for (const row of data ?? []) {
    const applicant = (row.row_data ?? {}) as DemoApplicantRow;
    if (!applicationRowEligibleForAutofill(applicant)) continue;
    const app = openApplicantRow(applicant, row.id).application;
    if (!app) continue;
    const profile = pickAutofillProfileFromApplication({
      ...createInitialRentalWizardState(),
      ...app,
    });
    if (!autofillProfileIsEmpty(profile)) {
      return { profile, customFieldAnswers: Array.isArray(app.customFieldAnswers) ? app.customFieldAnswers : [] };
    }
  }
  return null;
}

export async function loadResidentApplicationAutofillProfile(
  db: SupabaseClient,
  email: string,
): Promise<ResidentApplicationAutofillProfile | null> {
  return (await loadResidentApplicationAutofillBasis(db, email))?.profile ?? null;
}
