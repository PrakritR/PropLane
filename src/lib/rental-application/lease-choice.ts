/**
 * Step 1 of the application ("Your lease"): the applicant picks Long-term or Short-term, and the fields that
 * follow depend on it. Pure; the stored `leaseTerm` / `rentalType` values never change, so leases, pricing and
 * existing applications read the same.
 *
 *   Long-term   Move-in + Length. Length is one of the property's fixed lengths, "Custom dates" (then a Move-out
 *               date) or "Month-to-month" (no end date), the last only when the property offers it.
 *   Short-term  Check-in, check-out, the times and the house-rules acknowledgement.
 *
 * What the property offers (`allowedLeaseTerms`) is the source of truth. A choice that stores a term the
 * property does not offer is never produced here, and `validate.ts` still refuses one on the server.
 */
import { addMonthsToDateString, longTermLengthFor } from "@/lib/rental-application/long-term-length";
import {
  CUSTOM_LEASE_TERM,
  LONG_TERM_LEASE_TERM,
  MONTH_TO_MONTH_LEASE_TERM,
  SHORT_TERM_LEASE_TERM,
  leaseTypeIdForStoredTerm,
  leaseTypeIdsFromStored,
  storedTermForLeaseType,
  type LeaseTypeId,
} from "@/lib/rental-application/lease-terms";

export type LeaseKind = "long" | "short";

/** The Long-term / Short-term toggle and what each side holds, from the property's OFFERED stored terms. */
export type LeaseKindsOffered = {
  long: boolean;
  short: boolean;
  /** Long-term side: a fixed length list may apply. */
  longTerm: boolean;
  custom: boolean;
  monthToMonth: boolean;
};

export function leaseKindsOffered(offeredStored: readonly string[]): LeaseKindsOffered {
  const ids = new Set<LeaseTypeId>(leaseTypeIdsFromStored(offeredStored.map((t) => t.trim()).filter(Boolean)));
  const longTerm = ids.has("long_term");
  const custom = ids.has("custom");
  const monthToMonth = ids.has("month_to_month");
  return {
    long: longTerm || custom || monthToMonth,
    short: ids.has("short_term"),
    longTerm,
    custom,
    monthToMonth,
  };
}

/** The toggle shows only when the property offers both sides; a single side is just the form. */
export function showLeaseKindToggle(offeredStored: readonly string[]): boolean {
  const kinds = leaseKindsOffered(offeredStored);
  return kinds.long && kinds.short;
}

/** Which side a stored term is on (blank or unknown: null). */
export function leaseKindOfStored(stored: string | null | undefined): LeaseKind | null {
  const id = leaseTypeIdForStoredTerm(stored);
  if (!id) return null;
  return id === "short_term" ? "short" : "long";
}

/** The side the form is on right now, falling back to the only side offered. */
export function effectiveLeaseKind(
  form: { leaseTerm: string; rentalType: string },
  offeredStored: readonly string[],
): LeaseKind | null {
  if (form.rentalType === "short_term" || form.rentalType === "airbnb") return "short";
  const fromTerm = leaseKindOfStored(form.leaseTerm);
  if (fromTerm) return fromTerm;
  const kinds = leaseKindsOffered(offeredStored);
  if (kinds.long && !kinds.short) return "long";
  if (kinds.short && !kinds.long) return "short";
  return null;
}

/** The stored term a side starts on before anything else is picked. */
export function defaultStoredTermForKind(kind: LeaseKind, offeredStored: readonly string[]): string {
  const offered = offeredStored.map((t) => t.trim()).filter(Boolean);
  const kinds = leaseKindsOffered(offered);
  if (kind === "short") return storedTermForLeaseType("short_term", offered);
  if (kinds.longTerm) return storedTermForLeaseType("long_term", offered);
  if (kinds.custom) return CUSTOM_LEASE_TERM;
  if (kinds.monthToMonth) return MONTH_TO_MONTH_LEASE_TERM;
  return LONG_TERM_LEASE_TERM;
}

/** Patch applied when the toggle flips: new term and stay type, dates cleared, property and rooms kept. */
export function leaseKindPatch(
  kind: LeaseKind,
  offeredStored: readonly string[],
): { leaseTerm: string; rentalType: "standard" | "short_term"; leaseStart: string; leaseEnd: string } {
  const leaseTerm = defaultStoredTermForKind(kind, offeredStored);
  return {
    leaseTerm,
    // The stay type follows the stored term, as it always has: only "Short-Term Stay" is the short-term form.
    rentalType: leaseTerm === SHORT_TERM_LEASE_TERM ? "short_term" : "standard",
    leaseStart: "",
    leaseEnd: "",
  };
}

/** One entry of the Length dropdown. `value` is `m:<months>`, `custom` or `mtm`. */
export type LengthOption = { value: string; label: string };

export const CUSTOM_DATES_LENGTH_VALUE = "custom";
export const MONTH_TO_MONTH_LENGTH_VALUE = "mtm";
export const CUSTOM_DATES_LENGTH_LABEL = "Custom dates";
export const MONTH_TO_MONTH_LENGTH_LABEL = "Month-to-month";

/**
 * The Length dropdown for a Long-term lease: the property's fixed lengths (only when it offers Long-term),
 * "Custom dates", and "Month-to-month" only when the property offers it.
 */
export function longTermLengthOptions(offeredStored: readonly string[], fixedLengths: readonly number[]): LengthOption[] {
  const kinds = leaseKindsOffered(offeredStored);
  const out: LengthOption[] = [];
  if (kinds.longTerm) {
    for (const months of fixedLengths) {
      out.push({ value: `m:${months}`, label: `${months} ${months === 1 ? "month" : "months"}` });
    }
  }
  if (kinds.longTerm || kinds.custom) out.push({ value: CUSTOM_DATES_LENGTH_VALUE, label: CUSTOM_DATES_LENGTH_LABEL });
  if (kinds.monthToMonth) out.push({ value: MONTH_TO_MONTH_LENGTH_VALUE, label: MONTH_TO_MONTH_LENGTH_LABEL });
  return out;
}

/**
 * The stored term a Length choice writes. "Custom dates" stores "Custom" only when the property offers it
 * (its own fee and pricing row); otherwise it is a Long-term lease with an explicit move-out date.
 */
export function storedTermForLength(value: string, offeredStored: readonly string[]): string {
  const offered = offeredStored.map((t) => t.trim()).filter(Boolean);
  const kinds = leaseKindsOffered(offered);
  if (value === MONTH_TO_MONTH_LENGTH_VALUE) return MONTH_TO_MONTH_LEASE_TERM;
  if (value === CUSTOM_DATES_LENGTH_VALUE) {
    return kinds.custom ? CUSTOM_LEASE_TERM : storedTermForLeaseType("long_term", offered);
  }
  return storedTermForLeaseType("long_term", offered);
}

/** The Length dropdown value for what is stored. `customPicked` keeps "Custom dates" selected before a date is typed. */
export function lengthValueFromForm(
  form: { leaseTerm: string; leaseStart: string; leaseEnd: string },
  fixedLengths: readonly number[],
  customPicked = false,
): string {
  const id = leaseTypeIdForStoredTerm(form.leaseTerm);
  if (id === "month_to_month") return MONTH_TO_MONTH_LENGTH_VALUE;
  if (id === "custom") return CUSTOM_DATES_LENGTH_VALUE;
  if (id !== "long_term") return "";
  if (customPicked) return CUSTOM_DATES_LENGTH_VALUE;
  if (form.leaseEnd.trim()) {
    const months = longTermLengthFor(form.leaseStart, form.leaseEnd, fixedLengths);
    return months ? `m:${months}` : CUSTOM_DATES_LENGTH_VALUE;
  }
  return "";
}

/** Months behind a `m:<n>` value, or null. */
export function monthsOfLengthValue(value: string): number | null {
  if (!value.startsWith("m:")) return null;
  const months = Number(value.slice(2));
  return Number.isInteger(months) && months > 0 ? months : null;
}

/** Patch for picking a Length: the stored term, and the end date that follows from it. */
export function lengthPatch(
  value: string,
  offeredStored: readonly string[],
  leaseStart: string,
): { leaseTerm: string; leaseEnd: string } {
  const leaseTerm = storedTermForLength(value, offeredStored);
  if (value === MONTH_TO_MONTH_LENGTH_VALUE) return { leaseTerm, leaseEnd: "" };
  const months = monthsOfLengthValue(value);
  if (months && leaseStart) return { leaseTerm, leaseEnd: addMonthsToDateString(leaseStart, months) };
  return { leaseTerm, leaseEnd: "" };
}

/** Does the form carry a Move-out field (custom dates), a Length-driven end date, or neither (month-to-month)? */
export function longTermNeedsMoveOut(lengthValue: string): boolean {
  return lengthValue === CUSTOM_DATES_LENGTH_VALUE;
}

/** The Length the form carries, as words ("12 months", "Custom dates", "Month-to-month"), or "" when none is chosen. */
export function leaseLengthLabel(
  form: { leaseTerm: string; leaseStart: string; leaseEnd: string },
  fixedLengths: readonly number[],
): string {
  const value = lengthValueFromForm(form, fixedLengths);
  if (value === CUSTOM_DATES_LENGTH_VALUE) return CUSTOM_DATES_LENGTH_LABEL;
  if (value === MONTH_TO_MONTH_LENGTH_VALUE) return MONTH_TO_MONTH_LENGTH_LABEL;
  const months = monthsOfLengthValue(value);
  return months ? `${months} ${months === 1 ? "month" : "months"}` : "";
}
