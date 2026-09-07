/**
 * Seattle rent rule: every recurring monthly cost is RENT.
 *
 * On a Seattle listing there is no such thing as a separate monthly fee. A month-to-month
 * surcharge, a custom-calendar-lease surcharge, parking, HOA, "other monthly" and every
 * monthly custom fee are folded into the rent figure the resident is quoted, billed inside
 * the rent charge, and disclosed on the lease as the composition of that rent. Nothing about
 * this applies anywhere else: every other jurisdiction keeps its fees as their own lines.
 *
 * The decision is keyed on the SAME jurisdiction resolver the lease document uses
 * (`resolveLeaseJurisdiction`), fed the same inputs (listing property first, then the
 * submission), so the ledger and the document can never disagree about whether a listing is
 * in Seattle. That resolver is deliberately strict: a structured city is authoritative, a
 * ZIP-only match returns no city and so never promotes a Bellevue or Tacoma listing, and an
 * explicit out-of-scope state vetoes every string heuristic.
 */

import { resolveLeaseJurisdiction } from "@/lib/lease-jurisdiction";

/** The address fields the rule reads. Every listing submission and property record has them. */
export type RentRuleAddress = {
  address?: string;
  city?: string;
  state?: string;
  neighborhood?: string;
  zip?: string;
  postalCode?: string;
};

function addressOf(source: RentRuleAddress | null | undefined): RentRuleAddress | null {
  if (!source) return null;
  return {
    address: source.address,
    city: source.city,
    state: source.state,
    neighborhood: source.neighborhood,
    zip: source.zip,
    postalCode: source.postalCode,
  };
}

/**
 * True when this listing folds every recurring monthly fee into rent — i.e. it is in Seattle.
 *
 * `listingProperty` is the stored property record, which the lease resolver reads FIRST; pass
 * it whenever you have one so a legacy property whose submission never recorded a city still
 * resolves the way its lease does.
 */
export function listingFoldsAllMonthlyFeesIntoRent(
  submission: RentRuleAddress | null | undefined,
  listingProperty?: RentRuleAddress | null,
): boolean {
  if (!submission && !listingProperty) return false;
  return (
    resolveLeaseJurisdiction({
      listingProperty: addressOf(listingProperty),
      submission: addressOf(submission),
    }) === "seattle"
  );
}

/** Manager-facing note for the fees editor when the rule applies. */
export const SEATTLE_RENT_RULE_NOTE =
  "Seattle listing: monthly fees are added to the rent and shown on the lease as part of rent. They are never billed as a separate monthly charge.";
