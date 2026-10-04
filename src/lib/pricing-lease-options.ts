/**
 * The leasing options a priced thing (a room, a bundle, the whole house) is priced under, as the Pricing popup's
 * left tab rail and the wizard's Pricing card tabs list them (captain, Oct 3 2026):
 *
 *  - Long-term (always: the base the others follow),
 *  - Short-term, when the property offers stays,
 *  - each custom lease by name, when that lease routes a lease type of its own (a term other than Long-term,
 *    Short-term and Month-to-month),
 *  - Month-to-month, only when a lease allows it ("Allow month-to-month").
 *
 * Custom dates are an option of the Long-term lease (the Custom start surcharge row), never a tab of their own.
 * Each option names the stored lease term its fields are priced under, so the popup can show only that option's
 * fields and "What a resident pays" can quote it. Pure.
 */
import { resolveAllowedLeaseTerms, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { readPropertyLeaseTemplates } from "@/lib/property-lease-templates";
import {
  AIRBNB_LEASE_TERM,
  CUSTOM_LEASE_TERM,
  LONG_TERM_LEASE_TERM,
  SHORT_TERM_LEASE_TERM,
  isLegacyFixedLeaseTerm,
} from "@/lib/rental-application/lease-terms";

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
  if (terms.includes(AIRBNB_LEASE_TERM) || sub.airbnbRentalsAllowed) {
    options.push({ id: AIRBNB_LEASE_TERM, label: "Airbnb", term: AIRBNB_LEASE_TERM });
  }

  // A custom lease is its own option only when it routes a lease type of its own.
  for (const lease of leases) {
    if (lease.listingSeedKey && SEEDED_LEASES.has(lease.listingSeedKey)) continue;
    const own = (lease.applicationLeaseTerms ?? []).find(
      (term) =>
        term !== LONG_TERM_LEASE_TERM &&
        term !== SHORT_TERM_LEASE_TERM &&
        term !== AIRBNB_LEASE_TERM &&
        term !== CUSTOM_LEASE_TERM &&
        term !== MONTH_TO_MONTH_PRICING_TERM &&
        !isLegacyFixedLeaseTerm(term),
    );
    if (own) options.push({ id: `lease:${lease.id}`, label: lease.label?.trim() || "Lease", term: own });
  }

  const allowsMonthToMonth =
    terms.includes(MONTH_TO_MONTH_PRICING_TERM) ||
    leases.some((lease) => (lease.applicationLeaseTerms ?? []).includes(MONTH_TO_MONTH_PRICING_TERM));
  if (allowsMonthToMonth) options.push({ id: MONTH_TO_MONTH_PRICING_TERM, label: "Month-to-month", term: MONTH_TO_MONTH_PRICING_TERM });
  return options;
}
