import { listingAllowedLeaseTerms } from "@/lib/rental-application/data";
import {
  LEASE_TERM_CHOICES,
  LONG_TERM_LEASE_TERM,
  SHORT_TERM_LEASE_TERM,
  sortLeaseTermsCanonical,
} from "@/lib/rental-application/lease-terms";

/** Lease term choices for the renew-lease modal — scoped to what the listing offers. */
export function renewalLeaseTermOptionsForProperty(propertyId: string): string[] {
  const fromListing = propertyId.trim() ? listingAllowedLeaseTerms(propertyId.trim()) : [];
  // The offered choices, matching what a listing without stored terms now
  // presents everywhere else — not the full accepted set, which still carries
  // the retired 3/6/9/12-Month lengths.
  const fallback = [...LEASE_TERM_CHOICES, SHORT_TERM_LEASE_TERM];
  return sortLeaseTermsCanonical(fromListing.length > 0 ? fromListing : fallback);
}

export function renewalRentalTypeForTerm(leaseTerm: string): "standard" | "short_term" {
  return leaseTerm.trim() === SHORT_TERM_LEASE_TERM ? "short_term" : "standard";
}

const FIXED_LEASE_TERM_RE = /^\d+-Month$/;

export type ExtendMoveOutTypeId = "month_to_month" | "short_term" | "long_term" | "custom";

export type ExtendMoveOutTypeOption =
  | { id: "month_to_month"; label: "Month-to-month"; leaseTerm: "Month-to-Month" }
  | { id: "short_term"; label: "Short term"; leaseTerm: typeof SHORT_TERM_LEASE_TERM }
  | { id: "long_term"; label: "Long term"; leaseTerms: string[] }
  | { id: "custom"; label: "Custom" };

/** Resident extend-move-out types offered for a listing (month-to-month, short, fixed, custom). */
export function extendMoveOutTypesForProperty(propertyId: string): ExtendMoveOutTypeOption[] {
  const terms = renewalLeaseTermOptionsForProperty(propertyId);
  const options: ExtendMoveOutTypeOption[] = [];

  if (terms.includes("Month-to-Month")) {
    options.push({ id: "month_to_month", label: "Month-to-month", leaseTerm: "Month-to-Month" });
  }
  if (terms.includes(SHORT_TERM_LEASE_TERM)) {
    options.push({ id: "short_term", label: "Short term", leaseTerm: SHORT_TERM_LEASE_TERM });
  }

  // "Long-term" counts as a fixed term here alongside the retired N-Month
  // lengths. Matching only /^\d+-Month$/ meant that the moment listings started
  // offering "Long-term" (AXI-143) this filter went empty and the resident lost
  // the "Long term" extend option entirely.
  const fixedTerms = terms.filter(
    (term) =>
      term !== "Month-to-Month" &&
      term !== SHORT_TERM_LEASE_TERM &&
      term !== "Custom" &&
      (term === LONG_TERM_LEASE_TERM || FIXED_LEASE_TERM_RE.test(term)),
  );
  if (fixedTerms.length > 0) {
    options.push({ id: "long_term", label: "Long term", leaseTerms: fixedTerms });
  }

  options.push({ id: "custom", label: "Custom" });

  return options;
}
