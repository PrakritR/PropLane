import { isLegitimateEmail } from "@/lib/email-address";
import { GROUP_ID_PREFIX, LEGACY_GROUP_ID_PREFIX } from "@/lib/rental-application/application-groups";
import { coercePhoneInput } from "@/lib/phone-e164";
import { isCompletePhoneNumber } from "@/lib/phone-number-field";

/** US state / territory postal abbreviations used for rental address validation */
export const US_STATE_ABBREVS = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC", "AS", "GU", "MP", "PR", "VI",
]);

export function digitsOnly(s: string): string {
  return s.replace(/\D/g, "");
}

/** Full name: at least two words (first + last), each at least 2 letters */
export function validateFullName(name: string): { ok: true } | { ok: false; message: string } {
  const t = name.trim().replace(/\s+/g, " ");
  if (!t) return { ok: false, message: "Full name is required." };
  const parts = t.split(" ").filter(Boolean);
  if (parts.length < 2) return { ok: false, message: "Enter first and last name (at least two words)." };
  for (const p of parts) {
    if (p.length < 2) return { ok: false, message: "Each part of the name should be at least 2 characters." };
  }
  return { ok: true };
}

export function validateStateAbbrev(st: string): { ok: true } | { ok: false; message: string } {
  const u = st.trim().toUpperCase();
  if (u.length !== 2) return { ok: false, message: "State must be a 2-letter code (e.g. WA, CA)." };
  if (!US_STATE_ABBREVS.has(u)) return { ok: false, message: "Enter a valid US state or territory code." };
  return { ok: true };
}

const DEFAULT_SSN_FIELD_LABEL = "Social Security number";

/** The applicant-facing label for the SSN field: the catalog default reads "SSN or ITIN"; a manager's own label stands. */
export function ssnFieldLabel(label: string | null | undefined): string {
  const t = label?.trim();
  return !t || t === DEFAULT_SSN_FIELD_LABEL ? "SSN or ITIN" : t;
}

export function validateSsn(ssn: string): { ok: true } | { ok: false; message: string } {
  const d = digitsOnly(ssn);
  if (d.length !== 9) return { ok: false, message: "SSN or ITIN must be exactly 9 digits." };
  if (!isPlausibleSsn(d)) return { ok: false, message: "Enter a valid SSN or ITIN." };
  return { ok: true };
}

const OBVIOUS_FAKE_SSNS = new Set(["123456789", "987654321", "123121234", "111223333", "078051120", "219099999", "457555462"]);

/**
 * Format rules the SSA has never issued: area 000 or 666; group 00; serial 0000. Area 9xx is the IRS's: an ITIN
 * (group 50-65, 70-88, 90-92 or 94-99) is accepted, any other 9xx is not. Also the well-known placeholders
 * (123-45-6789, 987-65-4321, the Woolworth wallet number) and any run of one repeated digit.
 * Format only: it never says a number is real, and nothing here stores it.
 */
export function isPlausibleSsn(nineDigits: string): boolean {
  if (!/^\d{9}$/.test(nineDigits)) return false;
  const area = nineDigits.slice(0, 3);
  if (area === "000" || area === "666") return false;
  if (area.startsWith("9") && !isItinGroup(Number(nineDigits.slice(3, 5)))) return false;
  if (nineDigits.slice(3, 5) === "00" || nineDigits.slice(5) === "0000") return false;
  if (/^(\d)\1{8}$/.test(nineDigits)) return false;
  if (OBVIOUS_FAKE_SSNS.has(nineDigits)) return false;
  return true;
}

function isItinGroup(group: number): boolean {
  return (
    (group >= 50 && group <= 65) ||
    (group >= 70 && group <= 88) ||
    (group >= 90 && group <= 92) ||
    (group >= 94 && group <= 99)
  );
}

export function validatePhone10(phone: string): { ok: true } | { ok: false; message: string } {
  if (isCompletePhoneNumber(phone)) return { ok: true };
  return { ok: false, message: "Enter a valid phone number." };
}

/** Optional phone fields: blank is fine; a partial number is not. */
export function isBlankOrCompletePhone(phone: string): boolean {
  return !coercePhoneInput(phone) || isCompletePhoneNumber(phone);
}

export function validateEmail(email: string): { ok: true } | { ok: false; message: string } {
  const t = email.trim();
  if (!t) return { ok: false, message: "Email is required." };
  if (!isLegitimateEmail(t)) {
    return { ok: false, message: "Enter a valid email address (for example name@gmail.com)." };
  }
  return { ok: true };
}

export function validateRequired(value: string, label: string): { ok: true } | { ok: false; message: string } {
  if (!value.trim()) return { ok: false, message: `${label} is required.` };
  return { ok: true };
}

/**
 * The organizer's declared group size. Two is the smallest thing that is a
 * "group"; the upper bound just keeps a typo (30 instead of 3) from generating
 * an absurd split. Blank is rejected because the value drives both the group
 * roster and the even split of move-in costs.
 */
export const GROUP_SIZE_MIN = 2;
export const GROUP_SIZE_MAX = 12;

/**
 * The value the organizer's 2-12 stepper shows for whatever is stored — a blank left by clearing
 * the organizer id, or a legacy draft's "1" / "99". The wizard writes this back, so the control and
 * `validateGroupSize` can never disagree and leave the step refusing a number already on screen.
 */
export function normalizeGroupSize(value: string): number {
  const n = Number.parseInt((value ?? "").trim(), 10);
  return Math.min(GROUP_SIZE_MAX, Math.max(GROUP_SIZE_MIN, Number.isFinite(n) ? n : GROUP_SIZE_MIN));
}

export function validateGroupSize(value: string): { ok: true } | { ok: false; message: string } {
  const raw = value.trim();
  if (!raw) return { ok: false, message: "Tell us how many people are applying together." };
  if (!/^\d+$/.test(raw)) return { ok: false, message: "Enter a whole number of people." };
  const n = Number.parseInt(raw, 10);
  if (n < GROUP_SIZE_MIN) return { ok: false, message: "A group is 2 or more people. Choose “No” if you are applying alone." };
  if (n > GROUP_SIZE_MAX) return { ok: false, message: "That is more people than one application group supports (max 12)." };
  return { ok: true };
}

export function validateZip(zip: string): { ok: true } | { ok: false; message: string } {
  const t = zip.trim();
  if (!/^\d{5}(-\d{4})?$/.test(t)) return { ok: false, message: "ZIP must be 5 digits or ZIP+4 (e.g. 98105 or 98105-1234)." };
  return { ok: true };
}

export function validateMoney(value: string, label: string): { ok: true } | { ok: false; message: string } {
  const t = value.trim();
  if (!t) return { ok: false, message: `${label} is required.` };
  const n = Number(t.replace(/,/g, ""));
  if (!Number.isFinite(n) || n < 0) return { ok: false, message: `${label} must be a valid number (0 or greater).` };
  return { ok: true };
}

export function validateDateRequired(value: string, label: string): { ok: true } | { ok: false; message: string } {
  if (!value.trim()) return { ok: false, message: `${label} is required.` };
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return { ok: false, message: `${label} must be a valid date.` };
  return { ok: true };
}

/** Primary applicant group id shared with household (signer flow) */
export function validateAxisGroupId(id: string): { ok: true } | { ok: false; message: string } {
  const t = id.trim();
  if (!t) {
    return { ok: false, message: "Paste the Group ID the first applicant received after submitting." };
  }
  const prefixPattern = new RegExp(`^(${GROUP_ID_PREFIX}|${LEGACY_GROUP_ID_PREFIX})`, "i");
  if (!prefixPattern.test(t)) {
    return { ok: false, message: `Group ID must start with ${GROUP_ID_PREFIX}.` };
  }
  if (t.length < 12) {
    return { ok: false, message: "Paste the Group ID the first applicant received after submitting." };
  }
  return { ok: true };
}

export function validateHouseholdCount(raw: string): { ok: true } | { ok: false; message: string } {
  const t = raw.trim();
  if (!t) return { ok: false, message: "How many people are in your group is required." };
  const n = parseInt(t, 10);
  if (!Number.isFinite(n) || n < 2) {
    return { ok: false, message: "Enter a whole number of at least 2 (you plus at least one other person)." };
  }
  if (n > 30) return { ok: false, message: "Enter a group size between 2 and 30." };
  return { ok: true };
}
