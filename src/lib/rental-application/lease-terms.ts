/** Lease term labels shared by listing submission, rental application, and manager portal. */

export const LEASE_TERM_OPTIONS = ["3-Month", "6-Month", "9-Month", "12-Month", "Month-to-Month", "Custom"] as const;
export const SHORT_TERM_LEASE_TERM = "Short-Term Stay";
/** Off-platform channel stays — no PropLane rent charges; move-in and move-out required. */
export const AIRBNB_LEASE_TERM = "Airbnb";
/**
 * "Custom" is the escape hatch a manager/applicant reaches for when none of the
 * named terms fit, so it is always listed LAST — after Short-Term Stay — in
 * every place lease terms are displayed (application dropdown + listing form
 * checkboxes). Ordering only: its value, label, and behaviour are unchanged.
 */
export const CUSTOM_LEASE_TERM = "Custom";

export type LeaseTermOption = (typeof LEASE_TERM_OPTIONS)[number];

/** Standard lease lengths plus short-term when offered on a listing. */
export const LISTING_LEASE_TERM_OPTION_SET = new Set<string>([
  ...LEASE_TERM_OPTIONS,
  SHORT_TERM_LEASE_TERM,
  AIRBNB_LEASE_TERM,
]);

/**
 * Canonical display order for every surface that lists lease terms (application
 * dropdown + listing "Lease lengths offered" checkboxes): ascending by length,
 * then Short-Term Stay, then Custom LAST. Derived from `LEASE_TERM_OPTIONS`
 * (already 3 → 9 → 12 → Month-to-Month) with Short-Term inserted before the
 * Custom escape hatch — never hand-ordered, so the surfaces can never disagree.
 * A listing's stored `allowedLeaseTerms` may be in any historical order (that is
 * how 9-Month and 12-Month showed up transposed in production); sorting by this
 * makes stored order irrelevant.
 */
export const LEASE_TERM_DISPLAY_ORDER: string[] = [
  ...LEASE_TERM_OPTIONS.filter((t) => t !== CUSTOM_LEASE_TERM),
  SHORT_TERM_LEASE_TERM,
  AIRBNB_LEASE_TERM,
  CUSTOM_LEASE_TERM,
];

export function isAirbnbRentalType(rentalType?: string | null): boolean {
  return rentalType === "airbnb";
}

/** Order lease terms into `LEASE_TERM_DISPLAY_ORDER`; unknown values sort last, stably. */
export function sortLeaseTermsCanonical(terms: string[]): string[] {
  const rank = (t: string): number => {
    const i = LEASE_TERM_DISPLAY_ORDER.indexOf(t);
    return i === -1 ? LEASE_TERM_DISPLAY_ORDER.length : i;
  };
  return terms
    .map((term, index) => ({ term, index }))
    .sort((a, b) => rank(a.term) - rank(b.term) || a.index - b.index)
    .map((entry) => entry.term);
}
