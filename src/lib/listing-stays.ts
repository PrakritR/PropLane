/**
 * The two stays a listing can offer — Long term and Short term — and the one place they are set (the Basics
 * step's "Stays you offer"). Everything here is a reading or a patch over the EXISTING stored fields
 * (`allowedLeaseTerms` + `shortTermRentalsAllowed`, through `leaseTermsPatchForTypes`); there is no new field.
 *
 * Month-to-month and Custom are kinds of long-term let, so they count as "Long term" here and are kept
 * untouched while Long term stays on. Airbnb is a kind of short-term stay.
 *
 * Application, Lease and Move-in rows are grouped under exactly two sections, Long term and Short term
 * (`StaySectionKey`); there is no "Both" section. A row that applies to both stays is listed in EACH section as
 * the same item. A section only shows when the listing offers the stay. Hiding a section never deletes
 * anything. Pure.
 */
import {
  leaseTermsPatchForTypes,
  resolveOfferedLeaseTermsOrDefault,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import { leaseTypeIdsFromStored, type LeaseTypeId } from "@/lib/rental-application/lease-terms";

export type StayKey = "long_term" | "short_term";
/** A section of a leasing step: only the two stays, never "Both". */
export type StaySectionKey = StayKey;

export const STAY_LABEL: Record<StaySectionKey, string> = {
  long_term: "Long term",
  short_term: "Short term",
};

type StaySource = Pick<
  ManagerListingSubmissionV1,
  "allowedLeaseTerms" | "leaseTermsBody" | "shortTermRentalsAllowed" | "airbnbRentalsAllowed"
> &
  Partial<Pick<ManagerListingSubmissionV1, "rooms" | "longTermLengthsOffered">>;

/** Which stays the listing offers. A listing that never stated a choice offers Long term alone. */
export function listingOfferedStays(sub: StaySource | null | undefined): Record<StayKey, boolean> {
  const stored = resolveOfferedLeaseTermsOrDefault(sub);
  const ids = new Set<LeaseTypeId>(leaseTypeIdsFromStored(stored));
  const short = ids.has("short_term") || Boolean(sub?.shortTermRentalsAllowed);
  const long = ids.has("long_term") || ids.has("month_to_month") || ids.has("custom");
  // Never answer "nothing": a listing is always at least a long-term one.
  return { long_term: long || !short, short_term: short };
}

/** The sections a step draws, in order: each offered stay. */
export function visibleStaySections(sub: StaySource | null | undefined): StaySectionKey[] {
  const offered = listingOfferedStays(sub);
  const out: StaySectionKey[] = [];
  if (offered.long_term) out.push("long_term");
  if (offered.short_term) out.push("short_term");
  return out;
}

/**
 * The listing fields that change when the manager ticks the stays. At least one stay stays on: turning the
 * last one off answers `null` and the caller refuses it. Long term on keeps whichever long-term kinds
 * (Long-term, Month-to-month, Custom) the listing already offered; turning it on adds plain Long-term.
 */
export function staysPatch(
  sub: StaySource,
  next: Record<StayKey, boolean>,
): ReturnType<typeof leaseTermsPatchForTypes> | null {
  if (!next.long_term && !next.short_term) return null;
  const current = leaseTypeIdsFromStored(resolveOfferedLeaseTermsOrDefault(sub));
  const longKinds = current.filter((id) => id !== "short_term");
  const ids: LeaseTypeId[] = [];
  if (next.long_term) ids.push(...(longKinds.length > 0 ? longKinds : (["long_term"] as LeaseTypeId[])));
  if (next.short_term) ids.push("short_term");
  return leaseTermsPatchForTypes(sub, ids);
}

/**
 * How many rows a step's heading counts: only the rows drawn in a visible section, so an application for a
 * stay the listing does not offer is not counted, and a row that applies to both stays is counted once.
 */
export function countRowsInVisibleSections<T>(
  sub: StaySource | null | undefined,
  rows: readonly T[],
  sectionsOf: (row: T) => readonly StaySectionKey[],
): number {
  const visible = new Set<StaySectionKey>(visibleStaySections(sub));
  return rows.filter((row) => sectionsOf(row).some((section) => visible.has(section))).length;
}
