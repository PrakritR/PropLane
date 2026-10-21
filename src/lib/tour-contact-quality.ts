import { normalizePhoneE164 } from "@/lib/communication-other-recipients";
import { validateEmail } from "@/app/(rent)/rent/apply/apply-validation";

export type TourContactFields = {
  name: string;
  email: string;
  phone: string;
};

export type TourContactFieldErrors = Partial<Record<keyof TourContactFields, string>>;

/** Client and server validation for public tour booking contact details. */
export function validateTourContactFields(fields: TourContactFields): TourContactFieldErrors {
  const errors: TourContactFieldErrors = {};
  if (!fields.name.trim()) {
    errors.name = "Name is required.";
  }
  const emailResult = validateEmail(fields.email);
  if (!emailResult.ok) {
    errors.email = emailResult.message;
  }
  if (!normalizeTourContactPhone(fields.phone)) {
    errors.phone = "Phone number must be 10 digits.";
  }
  return errors;
}

/** Normalize a validated US phone to E.164 for storage and SMS. */
export function normalizeTourContactPhone(phone: string): string | null {
  return normalizePhoneE164(phone.trim());
}

/** Display-friendly US phone label for manager calendar and notifications. */
export function formatTourContactPhoneDisplay(phone: string): string {
  const e164 = normalizeTourContactPhone(phone);
  if (!e164) return phone.trim();
  const digits = e164.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return phone.trim();
}
