import type { RentalWizardFormState } from "./types";

/** Browser-local personal-info snapshot for the next rental application. */
const PROFILE_PREFILL_KEY = "axis:rental-application:profile-prefill:v1";

export type ApplicationProfilePrefill = Pick<
  RentalWizardFormState,
  | "fullLegalName"
  | "dateOfBirth"
  | "driversLicense"
  | "phone"
  | "email"
  | "currentStreet"
  | "currentCity"
  | "currentState"
  | "currentZip"
  | "currentLandlordName"
  | "currentLandlordPhone"
  | "currentMoveIn"
  | "currentMoveOut"
  | "currentReasonLeaving"
  | "noPreviousAddress"
  | "prevStreet"
  | "prevCity"
  | "prevState"
  | "prevZip"
  | "prevLandlordName"
  | "prevLandlordPhone"
  | "prevMoveIn"
  | "prevMoveOut"
  | "prevReasonLeaving"
  | "notEmployed"
  | "employer"
  | "employerAddress"
  | "supervisorName"
  | "supervisorPhone"
  | "jobTitle"
  | "monthlyIncome"
  | "annualIncome"
  | "employmentStart"
  | "otherIncome"
  | "ref1Name"
  | "ref1Relationship"
  | "ref1Phone"
  | "ref2Name"
  | "ref2Relationship"
  | "ref2Phone"
  | "occupancyCount"
  | "pets"
>;

function canUseStorage() {
  return typeof window !== "undefined";
}

function pickProfilePrefill(form: RentalWizardFormState): ApplicationProfilePrefill {
  return {
    fullLegalName: form.fullLegalName,
    dateOfBirth: form.dateOfBirth,
    driversLicense: form.driversLicense,
    phone: form.phone,
    email: form.email,
    currentStreet: form.currentStreet,
    currentCity: form.currentCity,
    currentState: form.currentState,
    currentZip: form.currentZip,
    currentLandlordName: form.currentLandlordName,
    currentLandlordPhone: form.currentLandlordPhone,
    currentMoveIn: form.currentMoveIn,
    currentMoveOut: form.currentMoveOut,
    currentReasonLeaving: form.currentReasonLeaving,
    noPreviousAddress: form.noPreviousAddress,
    prevStreet: form.prevStreet,
    prevCity: form.prevCity,
    prevState: form.prevState,
    prevZip: form.prevZip,
    prevLandlordName: form.prevLandlordName,
    prevLandlordPhone: form.prevLandlordPhone,
    prevMoveIn: form.prevMoveIn,
    prevMoveOut: form.prevMoveOut,
    prevReasonLeaving: form.prevReasonLeaving,
    notEmployed: form.notEmployed,
    employer: form.employer,
    employerAddress: form.employerAddress,
    supervisorName: form.supervisorName,
    supervisorPhone: form.supervisorPhone,
    jobTitle: form.jobTitle,
    monthlyIncome: form.monthlyIncome,
    annualIncome: form.annualIncome,
    employmentStart: form.employmentStart,
    otherIncome: form.otherIncome,
    ref1Name: form.ref1Name,
    ref1Relationship: form.ref1Relationship,
    ref1Phone: form.ref1Phone,
    ref2Name: form.ref2Name,
    ref2Relationship: form.ref2Relationship,
    ref2Phone: form.ref2Phone,
    occupancyCount: form.occupancyCount,
    pets: form.pets,
  };
}

export function loadApplicationProfilePrefill(): ApplicationProfilePrefill | null {
  if (!canUseStorage()) return null;
  try {
    const raw = window.localStorage.getItem(PROFILE_PREFILL_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ApplicationProfilePrefill;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function saveApplicationProfilePrefill(form: RentalWizardFormState) {
  if (!canUseStorage()) return;
  try {
    window.localStorage.setItem(PROFILE_PREFILL_KEY, JSON.stringify(pickProfilePrefill(form)));
  } catch {
    /* ignore quota / private mode */
  }
}

/** Fill blank personal fields from a prior application; never overwrites user input. */
export function mergeApplicationProfilePrefill(
  base: RentalWizardFormState,
  sessionEmail?: string | null,
): RentalWizardFormState {
  const prefill = loadApplicationProfilePrefill();
  if (!prefill) return base;

  const next = { ...base };
  for (const [key, value] of Object.entries(prefill) as [keyof ApplicationProfilePrefill, unknown][]) {
    if (key === "noPreviousAddress" || key === "notEmployed") {
      const current = next[key];
      if (current === null || current === undefined) {
        next[key] = value as RentalWizardFormState[typeof key];
      }
      continue;
    }
    const current = next[key];
    if (typeof current === "string" && current.trim()) continue;
    if (typeof value === "string" && value.trim()) {
      next[key] = value as RentalWizardFormState[typeof key];
    }
  }

  const email = (sessionEmail ?? next.email).trim().toLowerCase();
  if (email.includes("@") && !next.email.trim()) {
    next.email = email;
  }
  return next;
}
