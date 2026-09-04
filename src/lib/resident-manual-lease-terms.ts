import { listingAllowedLeaseTerms } from "@/lib/rental-application/data";
import {
  AIRBNB_LEASE_TERM,
  CUSTOM_LEASE_TERM,
  SHORT_TERM_LEASE_TERM,
} from "@/lib/rental-application/lease-terms";
import type { RentalWizardFormState } from "@/lib/rental-application/types";

/** Manual-resident lease type buckets (add/edit resident modals). */
export const RESIDENT_LEASE_TERM_SHORT = "short_term";
export const RESIDENT_LEASE_TERM_LONG = "long_term";
export const RESIDENT_LEASE_TERM_AIRBNB = "airbnb";
export const RESIDENT_LEASE_TERM_CUSTOM = "__custom__";

const LONG_TERM_LISTING_PREFERENCE = ["12-Month", "Month-to-Month", "6-Month", "9-Month", "3-Month"] as const;

const LEGACY_LISTING_TO_RESIDENT: Record<string, string> = {
  "Month-to-Month": RESIDENT_LEASE_TERM_LONG,
  "12-Month": RESIDENT_LEASE_TERM_LONG,
  "9-Month": RESIDENT_LEASE_TERM_LONG,
  "6-Month": RESIDENT_LEASE_TERM_LONG,
  "3-Month": RESIDENT_LEASE_TERM_LONG,
  [SHORT_TERM_LEASE_TERM]: RESIDENT_LEASE_TERM_SHORT,
  [AIRBNB_LEASE_TERM]: RESIDENT_LEASE_TERM_AIRBNB,
};

const LEGACY_RESIDENT_TO_LISTING: Record<string, string> = {
  "Month-to-month": "Month-to-Month",
  "12 months": "12-Month",
  "9 months": "9-Month",
  "6 months": "6-Month",
  "3 months": "3-Month",
  [SHORT_TERM_LEASE_TERM]: SHORT_TERM_LEASE_TERM,
  [RESIDENT_LEASE_TERM_SHORT]: SHORT_TERM_LEASE_TERM,
  [RESIDENT_LEASE_TERM_LONG]: "12-Month",
  [AIRBNB_LEASE_TERM]: AIRBNB_LEASE_TERM,
  [RESIDENT_LEASE_TERM_AIRBNB]: AIRBNB_LEASE_TERM,
};

function resolveLongTermListingLease(propertyId: string): string {
  const allowed = propertyId.trim() ? listingAllowedLeaseTerms(propertyId) : [];
  for (const term of LONG_TERM_LISTING_PREFERENCE) {
    if (allowed.length === 0 || allowed.includes(term)) return term;
  }
  return "12-Month";
}

/** Normalize manual-resident or legacy labels to application/listing lease-term values for templates and dates. */
export function normalizeApplicationLeaseTerm(raw: string, propertyId = ""): string {
  const t = raw.trim();
  if (!t) return "";
  if (t === RESIDENT_LEASE_TERM_SHORT) return SHORT_TERM_LEASE_TERM;
  if (t === RESIDENT_LEASE_TERM_AIRBNB) return AIRBNB_LEASE_TERM;
  if (t === RESIDENT_LEASE_TERM_LONG) return resolveLongTermListingLease(propertyId);
  if (LEGACY_RESIDENT_TO_LISTING[t]) return LEGACY_RESIDENT_TO_LISTING[t]!;
  if (t === "Month-to-Month" || t === CUSTOM_LEASE_TERM || t === AIRBNB_LEASE_TERM) return t;
  const legacyMonths = t.match(/^(\d+)\s*months?$/i);
  if (legacyMonths) return `${legacyMonths[1]}-Month`;
  return t;
}

/** Application fields needed so lease generation picks the right property template. */
export function residentLeaseTermToApplicationFields(
  residentLeaseTerm: string,
  customMode: boolean,
  propertyId = "",
): Pick<RentalWizardFormState, "leaseTerm" | "rentalType"> {
  const trimmed = residentLeaseTerm.trim();
  if (customMode) {
    if (!trimmed) return { leaseTerm: "", rentalType: "standard" };
    const fromCustom = normalizeApplicationLeaseTerm(trimmed, propertyId);
    if (fromCustom === SHORT_TERM_LEASE_TERM) {
      return { leaseTerm: SHORT_TERM_LEASE_TERM, rentalType: "short_term" };
    }
    if (fromCustom === AIRBNB_LEASE_TERM) {
      return { leaseTerm: AIRBNB_LEASE_TERM, rentalType: "airbnb" };
    }
    const standardTerms = new Set([
      "Month-to-Month",
      "3-Month",
      "6-Month",
      "9-Month",
      "12-Month",
      CUSTOM_LEASE_TERM,
    ]);
    if (standardTerms.has(fromCustom)) {
      return { leaseTerm: fromCustom, rentalType: "standard" };
    }
    return { leaseTerm: trimmed, rentalType: "standard" };
  }
  if (!trimmed) return { leaseTerm: "", rentalType: "standard" };
  if (trimmed === RESIDENT_LEASE_TERM_SHORT || trimmed === SHORT_TERM_LEASE_TERM) {
    return { leaseTerm: SHORT_TERM_LEASE_TERM, rentalType: "short_term" };
  }
  if (trimmed === RESIDENT_LEASE_TERM_AIRBNB || trimmed === AIRBNB_LEASE_TERM) {
    return { leaseTerm: AIRBNB_LEASE_TERM, rentalType: "airbnb" };
  }
  if (trimmed === RESIDENT_LEASE_TERM_LONG) {
    return { leaseTerm: resolveLongTermListingLease(propertyId), rentalType: "standard" };
  }
  const canonical = normalizeApplicationLeaseTerm(trimmed, propertyId);
  if (canonical === CUSTOM_LEASE_TERM) {
    return { leaseTerm: CUSTOM_LEASE_TERM, rentalType: "standard" };
  }
  if (canonical === AIRBNB_LEASE_TERM) {
    return { leaseTerm: AIRBNB_LEASE_TERM, rentalType: "airbnb" };
  }
  return { leaseTerm: canonical, rentalType: "standard" };
}

/** Map a listing/application lease term label to the manual-resident dropdown value. */
export function listingLeaseTermToResidentValue(term: string): string {
  const t = term.trim();
  if (!t) return "";
  if (LEGACY_LISTING_TO_RESIDENT[t]) return LEGACY_LISTING_TO_RESIDENT[t]!;
  if (t === SHORT_TERM_LEASE_TERM) return RESIDENT_LEASE_TERM_SHORT;
  if (t === AIRBNB_LEASE_TERM) return RESIDENT_LEASE_TERM_AIRBNB;
  if (t === CUSTOM_LEASE_TERM) return RESIDENT_LEASE_TERM_CUSTOM;
  if (/^\d+-Month$/i.test(t) || t === "Month-to-Month") return RESIDENT_LEASE_TERM_LONG;
  return t;
}

export type ResidentLeaseTermOption = { value: string; label: string };

/** Lease term choices for add/edit resident modals — short, long, airbnb, or custom. */
export function residentLeaseTermOptionsForProperty(propertyId: string): ResidentLeaseTermOption[] {
  const pid = propertyId.trim();
  const allowed = pid ? listingAllowedLeaseTerms(pid) : [];
  const options: ResidentLeaseTermOption[] = [
    { value: RESIDENT_LEASE_TERM_LONG, label: "Long term" },
    { value: RESIDENT_LEASE_TERM_CUSTOM, label: "Custom" },
  ];
  const shortAllowed = !pid || allowed.includes(SHORT_TERM_LEASE_TERM);
  if (shortAllowed) {
    options.unshift({ value: RESIDENT_LEASE_TERM_SHORT, label: "Short term" });
  }
  const airbnbAllowed = !pid || allowed.includes(AIRBNB_LEASE_TERM);
  if (airbnbAllowed) {
    const insertAt = shortAllowed ? 1 : 0;
    options.splice(insertAt, 0, { value: RESIDENT_LEASE_TERM_AIRBNB, label: "Airbnb" });
  }
  return options;
}

export function residentLeaseTermSelectValue(
  leaseTerm: string,
  customMode: boolean,
  presetValues: readonly string[],
): string {
  if (customMode) return RESIDENT_LEASE_TERM_CUSTOM;
  const trimmed = leaseTerm.trim();
  if (!trimmed) return "";
  if (presetValues.includes(trimmed)) return trimmed;
  return RESIDENT_LEASE_TERM_CUSTOM;
}

export function isResidentMonthToMonthLease(leaseTerm: string, propertyId = ""): boolean {
  const resolved = residentLeaseTermToApplicationFields(leaseTerm, false, propertyId).leaseTerm;
  return resolved === "Month-to-Month";
}

export function shouldUseResidentLeaseCustomMode(leaseTerm: string, presetValues: readonly string[]): boolean {
  const trimmed = leaseTerm.trim();
  if (!trimmed) return false;
  return !presetValues.includes(trimmed);
}
