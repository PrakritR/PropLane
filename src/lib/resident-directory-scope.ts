import { isProtectedOccupancyImportEmail } from "@/lib/auth/purge-manager-resident-orphans";
import type { DemoApplicantRow } from "@/data/demo-portal";

/**
 * A manager-portfolio row naming a resident by email is "linked to the
 * directory" when that email still has at least one application row of ANY
 * kind for this manager — Potential, Current, Past, or a decided-but-never-
 * deleted Rejected/Withdrawn row.
 *
 * WHY THIS EXISTS: deleting a resident removes their `manager_application_records`
 * row (and, since 633b90975, their leases/charges/services in the same
 * transaction going forward). But Bookings' lease bars, the Payments charges
 * list, Services' work-order/service-request lists, and dashboard KPIs each
 * read their own table directly with no resident-linkage check — so a row the
 * OLD fire-and-forget delete left behind, or a future bug, or any other stray
 * write, keeps rendering forever even though the person is gone from
 * Residents. This is the display-side backstop: it does not delete anything
 * (see `scripts/purge-orphaned-resident-data.mjs` for that), it only decides
 * whether a row that names an email with NO application row left at all gets
 * drawn.
 *
 * DELIBERATELY WIDER than `isResidentDirectoryRow` (current-resident.ts),
 * which decides whether a row appears IN the Residents tab and only counts
 * bucket "approved"/"pending" — a rejected or withdrawn applicant never shows
 * there, but the application row (and any real charge on it, e.g. an
 * application fee) is not deleted, and `manager-payments-scope.ts` already
 * has a deliberate, tested rule keeping a rejected/withdrawn applicant's
 * charges visible. Narrowing this predicate to the three directory stages
 * would silently re-hide those. The question this file answers is not "is
 * this person in the Residents tab" but "does this manager still have ANY
 * record of them" — an email with no application row in ANY bucket means the
 * person was actually deleted (or never existed), which is the only case
 * Bookings/Payments/Services/dashboard should treat as orphaned.
 *
 * Manager date blocks and Airbnb/Booking.com channel imports are never
 * "linked to a resident" and must not be treated as orphaned by this check —
 * `isProtectedOccupancyImportEmail` recognizes the reserved import
 * placeholder address and is always treated as linked.
 */

function normalizedEmail(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

/** Every email with at least one application row of any bucket for this manager. */
export function directoryResidentEmailSet(applications: readonly Pick<DemoApplicantRow, "email">[]): Set<string> {
  const emails = new Set<string>();
  for (const row of applications) {
    const email = normalizedEmail(row.email);
    if (email) emails.add(email);
  }
  return emails;
}

/**
 * True when `email` still has an application row for this manager (any
 * bucket), or is a channel-import placeholder that was never a directory
 * resident to begin with. False means the row is orphaned data left over
 * from a resident this manager has actually deleted, and should not render
 * on another surface.
 *
 * Takes a prebuilt `directoryEmails` set (from {@link directoryResidentEmailSet})
 * rather than the raw application rows, so a caller filtering many rows builds
 * the set once instead of rescanning applications per row.
 */
export function isLinkedToDirectoryResident(
  email: string | null | undefined,
  directoryEmails: ReadonlySet<string>,
): boolean {
  const normalized = normalizedEmail(email);
  if (!normalized) return false;
  if (isProtectedOccupancyImportEmail(normalized)) return true;
  return directoryEmails.has(normalized);
}
