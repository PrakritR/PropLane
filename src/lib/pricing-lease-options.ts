/**
 * The leasing options a priced thing (a room, a bundle, the whole house) is priced under, as the Pricing popup's
 * left tab rail and the wizard's Pricing card tabs list them (captain, Oct 3 2026):
 *
 *  - Long-term (always: the base the others follow),
 *  - Short-term, when the property offers stays,
 *  - a custom lease by name, when it is the lease that routes a lease type priced under a term of its own
 *    (Airbnb stays): the tab carries the lease's name,
 *  - Month-to-month, only when a lease allows it ("Allow month-to-month").
 *
 * Custom dates are an option of the Long-term lease (the Custom start surcharge row), never a tab of their own.
 * Each option names the stored lease term its fields are priced under, so the popup can show only that option's
 * fields and "What a resident pays" can quote it. Pure.
 */
import { resolveAllowedLeaseTerms, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { listingOfferedStays } from "@/lib/listing-stays";
import { readPropertyLeaseTemplates } from "@/lib/property-lease-templates";
import { AIRBNB_LEASE_TERM, LONG_TERM_LEASE_TERM, SHORT_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";

export const MONTH_TO_MONTH_PRICING_TERM = "Month-to-Month";

export type PricingLeaseOption = {
  /** Stable id: the stored term, or `lease:<id>` for a custom lease with a term of its own. */
  id: string;
  label: string;
  /** The stored lease term this option's fields are priced under. */
  term: string;
};

const SEEDED_LEASES = new Set(["primary", "short-term", "airbnb", "cosigner", "cosigner-short-term"]);

export function pricingLeaseOptions(
  sub: Pick<
    ManagerListingSubmissionV1,
    | "allowedLeaseTerms"
    | "leaseTermsBody"
    | "shortTermRentalsAllowed"
    | "airbnbRentalsAllowed"
    | "propertyLeaseTemplates"
    | "leaseConfigMode"
    | "leaseCustomKind"
    | "customLeaseTerms"
    | "leaseTemplateDocUrl"
    | "leaseTemplateDocName"
  >,
): PricingLeaseOption[] {
  const terms = resolveAllowedLeaseTerms(sub);
  const leases = readPropertyLeaseTemplates(sub).filter((lease) => lease.offered !== false);
  const options: PricingLeaseOption[] = [{ id: LONG_TERM_LEASE_TERM, label: "Long-term", term: LONG_TERM_LEASE_TERM }];

  const offersShort =
    terms.includes(SHORT_TERM_LEASE_TERM) ||
    Boolean(sub.shortTermRentalsAllowed) ||
    leases.some((lease) => lease.listingSeedKey === "short-term" || (lease.kind === "short-term" && !lease.listingSeedKey));
  if (offersShort) options.push({ id: SHORT_TERM_LEASE_TERM, label: "Short-term", term: SHORT_TERM_LEASE_TERM });
  // Airbnb stays are priced under their own term. A custom lease (not a PropLane default) that routes them is
  // that option, and the tab carries the lease's own name; otherwise the tab is "Airbnb".
  const customAirbnb = leases.find(
    (lease) => !(lease.listingSeedKey && SEEDED_LEASES.has(lease.listingSeedKey)) && (lease.applicationLeaseTerms ?? []).includes(AIRBNB_LEASE_TERM),
  );
  if (customAirbnb) {
    options.push({ id: `lease:${customAirbnb.id}`, label: customAirbnb.label?.trim() || "Airbnb", term: AIRBNB_LEASE_TERM });
  } else if (terms.includes(AIRBNB_LEASE_TERM) || sub.airbnbRentalsAllowed) {
    options.push({ id: AIRBNB_LEASE_TERM, label: "Airbnb", term: AIRBNB_LEASE_TERM });
  }

  const allowsMonthToMonth =
    terms.includes(MONTH_TO_MONTH_PRICING_TERM) ||
    leases.some((lease) => (lease.applicationLeaseTerms ?? []).includes(MONTH_TO_MONTH_PRICING_TERM));
  if (allowsMonthToMonth) options.push({ id: MONTH_TO_MONTH_PRICING_TERM, label: "Month-to-month", term: MONTH_TO_MONTH_PRICING_TERM });
  return options;
}

/**
 * The sections the wizard's Pricing step draws, one per stay the listing offers ("Stays you offer" on Basics):
 * Long term and Short term each hold their OWN rent, deposit, move-in fee, application fee and added fees, and
 * nothing is shared between them. There is no Both section on Pricing. A stay the listing does not offer
 * draws nothing (its stored prices are kept); Airbnb is a kind of short-term stay, Month-to-month and a custom
 * lease a kind of long-term one, so they follow their stay.
 */
export function pricingSectionOptions(sub: Parameters<typeof pricingLeaseOptions>[0]): PricingLeaseOption[] {
  const offered = listingOfferedStays(sub);
  return pricingLeaseOptions(sub).filter((option) => {
    if (option.term === SHORT_TERM_LEASE_TERM || option.term === AIRBNB_LEASE_TERM) return offered.short_term;
    if (option.term === LONG_TERM_LEASE_TERM) return offered.long_term;
    return offered.long_term;
  });
}
