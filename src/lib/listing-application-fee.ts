import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import {
  AIRBNB_LEASE_TERM,
  isLegacyFixedLeaseTerm,
  LONG_TERM_LEASE_TERM,
  SHORT_TERM_LEASE_TERM,
} from "@/lib/rental-application/lease-terms";

/**
 * The application fee, per lease type.
 *
 * `applicationFee` is the one amount. `applicationFeeByLeaseType` holds only the
 * lease types the manager priced differently — a type with no entry FOLLOWS the
 * one amount, the same rule a room follows the Default room by. The older
 * `shortTermApplicationFee` is still read as the stay fallback so a listing saved
 * before the map existed charges exactly what it did.
 *
 * Precedence: the lease type's own entry → the legacy short-term fee (stays
 * only) → the one amount. A retired fixed length (3/6/9/12-Month) is Long-term.
 */

/** The key a stored lease term is priced under. */
export function applicationFeeLeaseTypeKey(leaseTerm: string | null | undefined): string {
  const term = String(leaseTerm ?? "").trim();
  if (isLegacyFixedLeaseTerm(term)) return LONG_TERM_LEASE_TERM;
  return term;
}

function isStayTerm(term: string): boolean {
  return term === SHORT_TERM_LEASE_TERM || term === AIRBNB_LEASE_TERM;
}

/** Raw per-listing application fee label before manager-default fallback. */
export function listingApplicationFeeRaw(
  listing: ManagerListingSubmissionV1 | null | undefined,
  rentalType?: "standard" | "short_term",
  leaseTerm?: string | null,
): string {
  if (!listing) return "";
  const key = applicationFeeLeaseTypeKey(leaseTerm);
  if (key) {
    const own = String(listing.applicationFeeByLeaseType?.[key] ?? "").trim();
    if (own !== "") return own;
  }
  if (rentalType === "short_term" || isStayTerm(key)) {
    const st = String(listing.shortTermApplicationFee ?? "").trim();
    if (st !== "") return st;
  }
  return String(listing.applicationFee ?? "").trim();
}

/**
 * Keep only real, offered lease types with a typed amount; `undefined` when
 * nothing differs from the one amount, so an untouched listing stores nothing.
 */
export function normalizeApplicationFeeByLeaseType(
  raw: unknown,
  offeredTerms: readonly string[],
): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const offered = new Set(offeredTerms.map(applicationFeeLeaseTypeKey));
  const out: Record<string, string> = {};
  for (const [term, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "string") continue;
    const amount = value.trim();
    if (amount === "") continue;
    const key = applicationFeeLeaseTypeKey(term);
    if (!offered.has(key)) continue;
    out[key] = amount;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
