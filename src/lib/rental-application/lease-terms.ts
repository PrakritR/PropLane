/** Lease term labels shared by listing submission, rental application, and manager portal. */

/**
 * Every lease term the system ACCEPTS, including the fixed lengths that listings
 * and signed leases still carry. This set is what normalization validates
 * against, so a stored "12-Month" keeps working forever — see
 * {@link LEASE_TERM_CHOICES} for the much shorter list a human is now OFFERED.
 */
export const LEASE_TERM_OPTIONS = [
  "3-Month",
  "6-Month",
  "9-Month",
  "12-Month",
  "Long-term",
  "Month-to-Month",
  "Custom",
] as const;
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

/**
 * A fixed-term lease whose length is defined by the move-in and move-out dates
 * rather than by a named number of months.
 *
 * Replaces 3/6/9/12-Month in every picker: a manager offers "Long-term" and the
 * applicant's chosen dates ARE the term. It deliberately has no month count, so
 * `shouldAutoComputeLeaseEnd` declines to invent an end date and the applicant's
 * move-out date is used verbatim — and because it is not Month-to-Month, a lease
 * whose dates do not line up with calendar months still bills the custom-lease
 * surcharge exactly as a fixed term does.
 *
 * The old lengths are still ACCEPTED (see LEASE_TERM_OPTIONS) so signed leases
 * and existing listings are untouched; they are simply no longer offered.
 */
export const LONG_TERM_LEASE_TERM = "Long-term";

/**
 * What a manager offers and an applicant picks: four choices, not seven.
 *
 * Short-Term Stay and Airbnb are added per listing by `resolveAllowedLeaseTerms`
 * when that listing permits them, so a plain long-term listing shows exactly
 * Long-term / Month-to-month / Custom.
 */
export const LEASE_TERM_CHOICES: string[] = [
  LONG_TERM_LEASE_TERM,
  "Month-to-Month",
  CUSTOM_LEASE_TERM,
];

/** True for the named fixed lengths that are no longer offered but still stored. */
export function isLegacyFixedLeaseTerm(term: string | null | undefined): boolean {
  const t = String(term ?? "").trim();
  return t === "3-Month" || t === "6-Month" || t === "9-Month" || t === "12-Month";
}

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
  // Legacy lengths first so a listing that still carries one sorts sensibly,
  // then the offered choices, then the escape hatch last.
  "3-Month",
  "6-Month",
  "9-Month",
  "12-Month",
  LONG_TERM_LEASE_TERM,
  "Month-to-Month",
  SHORT_TERM_LEASE_TERM,
  AIRBNB_LEASE_TERM,
  CUSTOM_LEASE_TERM,
];

export function isAirbnbRentalType(rentalType?: string | null): boolean {
  return rentalType === "airbnb";
}

/**
 * The two-value rental type the application form, its field catalog and the
 * bundle helpers understand.
 *
 * `RentalWizardFormState.rentalType` gained "airbnb" for the September occupancy
 * roster, but those consumers were written for `standard | short_term` and were
 * left un-widened — which is what put 14 type errors on the branch. An Airbnb
 * stay IS a short stay to every one of them, and the charge path already treats
 * it that way (`household-charges.ts` skips both when syncing approved standard
 * charges), so mapping here keeps one definition of that rule instead of
 * scattering `=== "airbnb"` through the form.
 */
export function applicationRentalTypeFor(rentalType?: string | null): "standard" | "short_term" {
  return rentalType === "short_term" || rentalType === "airbnb" ? "short_term" : "standard";
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
