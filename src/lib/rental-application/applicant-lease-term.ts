/**
 * What the applicant picks for "Lease term" -- exactly Long-term or Short-term, filtered to what the property
 * offers (captain, Oct 3 2026: "lease terms should be long term or short term").
 *
 * This is a PRESENTATION layer. Month-to-month and custom dates are options OF the long-term lease, not
 * separate terms, but the stored value (`form.leaseTerm`, what the server receives and what routes through
 * `application-lease-mapping.ts` and the one fee resolver) stays one of the existing stored terms, so
 * nothing downstream moves and the fee preview equals the amount charged:
 *
 *   Long-term, Fixed term            -> "Long-term"   (or "Custom" when the start is mid-month and the property
 *                                        allows custom dates: only Custom may start mid-month and owes its surcharge)
 *   Long-term, Month-to-month        -> "Month-to-Month"
 *   Short-term                       -> "Short-Term Stay" (else "Airbnb" when that is all the property offers)
 *
 * Stored values read back for display: Custom, 3/6/9/12-Month and Month-to-Month are Long-term; Short-Term Stay
 * and Airbnb are Short-term. Pure.
 */
import {
  AIRBNB_LEASE_TERM,
  CUSTOM_LEASE_TERM,
  LONG_TERM_LEASE_TERM,
  SHORT_TERM_LEASE_TERM,
  isLegacyFixedLeaseTerm,
} from "@/lib/rental-application/lease-terms";

const MONTH_TO_MONTH = "Month-to-Month";

export type ApplicantTerm = "long" | "short";
export type ApplicantLength = "fixed" | "month_to_month";

export const APPLICANT_TERM_PLACEHOLDER = "Select a lease term";

export function isShortStoredTerm(stored: string | null | undefined): boolean {
  const term = String(stored ?? "").trim();
  return term === SHORT_TERM_LEASE_TERM || term === AIRBNB_LEASE_TERM;
}

/** The terms the dropdown offers, in order, from the property's OFFERED stored terms. */
export function applicantTermOptions(offeredStored: readonly string[]): { value: ApplicantTerm; label: string }[] {
  const offered = offeredStored.map((term) => term.trim()).filter(Boolean);
  const hasLong = offered.some((term) => !isShortStoredTerm(term));
  const hasShort = offered.some(isShortStoredTerm);
  return [
    ...(hasLong ? [{ value: "long" as const, label: "Long-term" }] : []),
    ...(hasShort ? [{ value: "short" as const, label: "Short-term" }] : []),
  ];
}

/** Does a long-term lease on this property allow month-to-month / custom dates? */
export const propertyAllowsMonthToMonth = (offered: readonly string[]) => offered.includes(MONTH_TO_MONTH);
export const propertyAllowsCustomDates = (offered: readonly string[]) => offered.includes(CUSTOM_LEASE_TERM);

/** What a stored `leaseTerm` shows as: "" while unanswered. */
export function applicantChoiceFromStored(stored: string | null | undefined): { term: ApplicantTerm | ""; length: ApplicantLength } {
  const value = String(stored ?? "").trim();
  if (!value) return { term: "", length: "fixed" };
  if (isShortStoredTerm(value)) return { term: "short", length: "fixed" };
  return { term: "long", length: value === MONTH_TO_MONTH ? "month_to_month" : "fixed" };
}

/** A start date's day of month (1-31), or null for a missing / malformed date. */
function startDay(leaseStart: string | null | undefined): number | null {
  const match = /^\d{4}-\d{2}-(\d{2})$/.exec(String(leaseStart ?? "").trim());
  return match ? Number(match[1]) : null;
}

/**
 * The stored term for what the applicant picked. `offered` is the property's OFFERED stored terms
 * (`listingOfferedLeaseTerms`), so the result is always a term the property accepts.
 */
export function storedTermForApplicant(input: {
  offered: readonly string[];
  term: ApplicantTerm;
  length?: ApplicantLength;
  leaseStart?: string | null;
}): string {
  const offered = input.offered.map((term) => term.trim()).filter(Boolean);
  if (input.term === "short") {
    return offered.includes(SHORT_TERM_LEASE_TERM) ? SHORT_TERM_LEASE_TERM : offered.includes(AIRBNB_LEASE_TERM) ? AIRBNB_LEASE_TERM : SHORT_TERM_LEASE_TERM;
  }
  if (input.length === "month_to_month" && offered.includes(MONTH_TO_MONTH)) return MONTH_TO_MONTH;
  const hasLong = offered.includes(LONG_TERM_LEASE_TERM);
  const hasCustom = offered.includes(CUSTOM_LEASE_TERM);
  if (hasLong && hasCustom) {
    // Only Custom may start mid-month (and owes the Custom start surcharge); a first-of-the-month start is Long-term.
    const day = startDay(input.leaseStart);
    return day !== null && day !== 1 ? CUSTOM_LEASE_TERM : LONG_TERM_LEASE_TERM;
  }
  if (hasLong) return LONG_TERM_LEASE_TERM;
  if (hasCustom) return CUSTOM_LEASE_TERM;
  // A listing that still stores only retired fixed lengths: the first of them (they all read as Long-term).
  return offered.find((term) => isLegacyFixedLeaseTerm(term)) ?? LONG_TERM_LEASE_TERM;
}

/**
 * After the start date changes: the stored term to keep. Only a fixed long-term answer on a property that
 * offers both Long-term and Custom can change (a mid-month start is Custom); everything else is left alone.
 */
export function storedTermAfterStartChange(input: {
  offered: readonly string[];
  currentStored: string;
  leaseStart: string;
}): string {
  const current = input.currentStored.trim();
  if (current !== LONG_TERM_LEASE_TERM && current !== CUSTOM_LEASE_TERM) return current;
  if (!input.offered.includes(LONG_TERM_LEASE_TERM) || !input.offered.includes(CUSTOM_LEASE_TERM)) return current;
  return storedTermForApplicant({ offered: input.offered, term: "long", length: "fixed", leaseStart: input.leaseStart });
}
