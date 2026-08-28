import type { DemoApplicantRow } from "@/data/demo-portal";
import { readManagerApplicationRows } from "@/lib/manager-applications-storage";
import { isDraftShapedApplicationRow } from "@/lib/rental-application/draft-shape";
import { isWithdrawnApplicationRow } from "@/lib/rental-application/resident-application-list";
import type { RentalWizardFormState } from "@/lib/rental-application/types";
import { createInitialRentalWizardState } from "@/lib/rental-application/state";

/** Fields copied from a prior application — never property-, date-, or fee-specific. */
export const RESIDENT_APPLICATION_AUTOFILL_KEYS = [
  "fullLegalName",
  "dateOfBirth",
  "ssn",
  "driversLicense",
  "idPhotoFront",
  "idPhotoBack",
  "phone",
  "currentStreet",
  "currentCity",
  "currentState",
  "currentZip",
  "currentLandlordName",
  "currentLandlordPhone",
  "currentMoveIn",
  "currentMoveOut",
  "currentReasonLeaving",
  "noPreviousAddress",
  "prevStreet",
  "prevCity",
  "prevState",
  "prevZip",
  "prevLandlordName",
  "prevLandlordPhone",
  "prevMoveIn",
  "prevMoveOut",
  "prevReasonLeaving",
  "notEmployed",
  "employer",
  "employerAddress",
  "supervisorName",
  "supervisorPhone",
  "jobTitle",
  "monthlyIncome",
  "annualIncome",
  "employmentStart",
  "otherIncome",
  "incomeProofPhotos",
  "ref1Name",
  "ref1Relationship",
  "ref1Phone",
  "ref2Name",
  "ref2Relationship",
  "ref2Phone",
  "occupancyCount",
  "pets",
  "evictionHistory",
  "evictionDetails",
  "bankruptcyHistory",
  "bankruptcyDetails",
  "criminalHistory",
  "criminalDetails",
] as const satisfies readonly (keyof RentalWizardFormState)[];

export type ResidentApplicationAutofillProfile = Pick<
  RentalWizardFormState,
  (typeof RESIDENT_APPLICATION_AUTOFILL_KEYS)[number]
>;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function applicationRowEligibleForAutofill(row: DemoApplicantRow): boolean {
  if (isWithdrawnApplicationRow(row)) return false;
  if (isDraftShapedApplicationRow(row)) return false;
  const app = row.application;
  return Boolean(app?.fullLegalName?.trim() || app?.phone?.trim() || app?.currentStreet?.trim());
}

export function pickAutofillProfileFromApplication(
  application: RentalWizardFormState,
): ResidentApplicationAutofillProfile {
  const picked = {} as ResidentApplicationAutofillProfile;
  for (const key of RESIDENT_APPLICATION_AUTOFILL_KEYS) {
    const value = application[key];
    if (value !== undefined && value !== null && value !== "") {
      (picked as Record<string, unknown>)[key] = value;
    }
  }
  return picked;
}

export function mergeAutofillIntoWizardState(
  current: RentalWizardFormState,
  profile: Partial<ResidentApplicationAutofillProfile>,
): RentalWizardFormState {
  const next = { ...current };
  for (const key of RESIDENT_APPLICATION_AUTOFILL_KEYS) {
    const incoming = profile[key];
    if (incoming === undefined || incoming === null) continue;
    if (typeof incoming === "string" && !incoming.trim()) continue;
    if (Array.isArray(incoming) && incoming.length === 0) continue;
    (next as Record<string, unknown>)[key] = incoming;
  }
  return next;
}

export function autofillProfileIsEmpty(profile: Partial<ResidentApplicationAutofillProfile>): boolean {
  return RESIDENT_APPLICATION_AUTOFILL_KEYS.every((key) => {
    const value = profile[key];
    if (value == null) return true;
    if (typeof value === "string") return !value.trim();
    if (Array.isArray(value)) return value.length === 0;
    return false;
  });
}

/** Browser cache — applications already synced for this account. */
export function latestAutofillProfileFromLocalRows(email: string): ResidentApplicationAutofillProfile | null {
  const e = normalizeEmail(email);
  if (!e) return null;
  const rows = readManagerApplicationRows()
    .filter((row) => normalizeEmail(row.email ?? row.application?.email ?? "") === e)
    .filter(applicationRowEligibleForAutofill);
  if (rows.length === 0) return null;
  const latest = rows[rows.length - 1]?.application;
  if (!latest) return null;
  const profile = pickAutofillProfileFromApplication({ ...createInitialRentalWizardState(), ...latest });
  return autofillProfileIsEmpty(profile) ? null : profile;
}
