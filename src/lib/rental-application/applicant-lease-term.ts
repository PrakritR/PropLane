/**
 * What the applicant picks for "Lease term": Long-term or Short-term, whichever the property enabled (captain,
 * Oct 8 2026). Custom dates and Month-to-month are not choices of their own: they are checkboxes under
 * Long-term, present only when the property allows them (`applicantLongTermChildren`). The types, their labels
 * and their stored terms live in `lease-terms.ts` (`LEASE_TYPES`, `LEASE_PICK_OPTIONS`); this module is the
 * applicant edge over them.
 *
 * The stored value (`form.leaseTerm`, what the server receives and what routes through the one fee resolver,
 * the lease document and the charge ledger) stays one of the existing stored terms, so nothing downstream
 * moves and the fee preview equals the amount charged. The pick decides what the dates step asks for:
 *
 *   Long-term       start + end date (or one of the manager's fixed lengths)
 *   Short-term      check-in + check-out
 *   Custom          start + end date chosen by the applicant
 *   Month-to-month  start date only, no end date
 *
 * Pure.
 */
import {
  LEASE_PICK_OPTIONS,
  leasePickFromStored,
  leaseTypeIdForStoredTerm,
  leaseTypeIdsFromStored,
  storedTermForLeaseType,
  type LeaseTypeId,
} from "@/lib/rental-application/lease-terms";

export type ApplicantTerm = LeaseTypeId;

export const APPLICANT_TERM_PLACEHOLDER = "Select a lease term";

/**
 * The top-level options the applicant sees, in order, from the property's OFFERED stored terms. A property that
 * offers only Custom or Month-to-month is a Long-term lease with that option, so it still reads as Long-term.
 */
export function applicantTermOptions(offeredStored: readonly string[]): { value: ApplicantTerm; label: string }[] {
  const picked = new Set(leasePickFromStored(offeredStored.map((term) => term.trim()).filter(Boolean)));
  return LEASE_PICK_OPTIONS.filter((option) => !option.parent && picked.has(option.value)).map((option) => ({
    value: option.value,
    label: option.label,
  }));
}

/** The checkboxes under Long-term: only the ones the property ticked (Custom dates, Month-to-month). */
export function applicantLongTermChildren(offeredStored: readonly string[]): { value: ApplicantTerm; label: string }[] {
  const offered = new Set(leaseTypeIdsFromStored(offeredStored.map((term) => term.trim()).filter(Boolean)));
  return LEASE_PICK_OPTIONS.filter((option) => option.parent === "long_term" && offered.has(option.value)).map((option) => ({
    value: option.value,
    label: option.label,
  }));
}

/** What a stored `leaseTerm` shows as: "" while unanswered. */
export function applicantChoiceFromStored(stored: string | null | undefined): ApplicantTerm | "" {
  return leaseTypeIdForStoredTerm(stored) ?? "";
}

/** The stored term for what the applicant picked. */
export function storedTermForApplicant(input: { offered: readonly string[]; term: ApplicantTerm }): string {
  return storedTermForLeaseType(input.term, input.offered.map((term) => term.trim()).filter(Boolean));
}

/** A property that enables exactly one lease type needs no question: its stored term, else null. */
export function onlyOfferedStoredTerm(offeredStored: readonly string[]): string | null {
  // Sole means one stored lease type: Long-term plus a Custom dates option is still a question.
  const ids = leaseTypeIdsFromStored(offeredStored.map((term) => term.trim()).filter(Boolean));
  return ids.length === 1 ? storedTermForApplicant({ offered: offeredStored, term: ids[0]! }) : null;
}
