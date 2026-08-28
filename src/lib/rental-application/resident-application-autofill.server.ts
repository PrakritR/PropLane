import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoApplicantRow } from "@/data/demo-portal";
import {
  applicationRowEligibleForAutofill,
  pickAutofillProfileFromApplication,
  type ResidentApplicationAutofillProfile,
  autofillProfileIsEmpty,
} from "@/lib/rental-application/resident-application-autofill";
import { createInitialRentalWizardState } from "@/lib/rental-application/state";

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function loadResidentApplicationAutofillProfile(
  db: SupabaseClient,
  email: string,
): Promise<ResidentApplicationAutofillProfile | null> {
  const e = normalizeEmail(email);
  if (!e) return null;
  const { data, error } = await db
    .from("manager_application_records")
    .select("row_data, updated_at")
    .eq("resident_email", e)
    .order("updated_at", { ascending: false })
    .limit(40);
  if (error) throw error;
  for (const row of data ?? []) {
    const applicant = (row.row_data ?? {}) as DemoApplicantRow;
    if (!applicationRowEligibleForAutofill(applicant)) continue;
    const app = applicant.application;
    if (!app) continue;
    const profile = pickAutofillProfileFromApplication({
      ...createInitialRentalWizardState(),
      ...app,
    });
    if (!autofillProfileIsEmpty(profile)) return profile;
  }
  return null;
}
