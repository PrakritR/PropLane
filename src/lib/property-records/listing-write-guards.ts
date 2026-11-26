import { resolveAllowedLeaseTerms, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

/**
 * Two pure guards of a listing write, shared by `POST /api/property-records` and the by-text publish core
 * (`publish-listing.server.ts`) so a listing published from a phone is held to exactly the rules the Add property wizard is.
 */

/** The listing submission this write's `rowData`/`propertyData` carries, checking either bucket. Used only to size the
 * door-cap check and the lease-term guard, never to store anything. */
export function incomingListingSubmission(rowData: unknown, propertyData: unknown): unknown {
  const submissionFrom = (container: unknown): unknown => {
    if (!container || typeof container !== "object" || Array.isArray(container)) return undefined;
    const record = container as Record<string, unknown>;
    return record.submission ?? record.listingSubmission;
  };
  return submissionFrom(rowData) ?? submissionFrom(propertyData);
}

/**
 * A property must offer at least one lease type. A submission that explicitly carries an EMPTY
 * `allowedLeaseTerms` is refused: `resolveAllowedLeaseTerms` then answers [], and the
 * applicant-side fallback reads that as EVERY lease term — the opposite of what the editor
 * showed. A submission that names no choice at all is a legacy row and keeps its existing
 * default, so this only ever refuses a write that actively clears the field.
 */
export function emptyLeaseTermsWrite(submission: unknown): boolean {
  if (!submission || typeof submission !== "object" || Array.isArray(submission)) return false;
  const sub = submission as Record<string, unknown>;
  if (!Array.isArray(sub.allowedLeaseTerms)) return false;
  return (
    resolveAllowedLeaseTerms(
      sub as Pick<
        ManagerListingSubmissionV1,
        "allowedLeaseTerms" | "leaseTermsBody" | "shortTermRentalsAllowed" | "airbnbRentalsAllowed"
      >,
    ).length === 0
  );
}
