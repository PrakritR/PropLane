/**
 * What the applicant picks for "Lease term": one select listing ONLY the lease types the property enabled, in
 * the order Long-term, Short-term, Custom, Month-to-month (captain, Oct 4 2026). The four types, their labels
 * and their stored terms live in `lease-terms.ts` (`LEASE_TYPES`); this module is the applicant edge over them.
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
  LEASE_TYPES,
  leaseTypeIdForStoredTerm,
  leaseTypeIdsFromStored,
  storedTermForLeaseType,
  type LeaseTypeId,
} from "@/lib/rental-application/lease-terms";

export type ApplicantTerm = LeaseTypeId;

export const APPLICANT_TERM_PLACEHOLDER = "Select a lease term";

/** The options the dropdown offers, in order, from the property's OFFERED stored terms. */
export function applicantTermOptions(offeredStored: readonly string[]): { value: ApplicantTerm; label: string }[] {
  const offered = new Set(leaseTypeIdsFromStored(offeredStored.map((term) => term.trim()).filter(Boolean)));
  return LEASE_TYPES.filter((type) => offered.has(type.id)).map((type) => ({ value: type.id, label: type.label }));
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
  const options = applicantTermOptions(offeredStored);
  return options.length === 1 ? storedTermForApplicant({ offered: offeredStored, term: options[0]!.value }) : null;
}
