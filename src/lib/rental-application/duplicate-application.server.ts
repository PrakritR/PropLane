import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { DemoApplicantRow } from "@/data/demo-portal";
import { isDraftShapedApplicationRow } from "@/lib/rental-application/draft-shape";
import { isWithdrawnApplicationRow } from "@/lib/rental-application/resident-application-list";

/**
 * The server's answer to "has this person already applied to this room?"
 *
 * The only duplicate guard was `residentApplicationSubmitBlocked`, which reads
 * `window.sessionStorage` — so it passed in a new tab, on another device, in
 * incognito, for a guest applicant, and after the session store was cleared
 * (PRP-204). The manager then got two pending applications for the same person
 * and room with nothing marking them as duplicates, and under an
 * `every_time` fee policy the applicant was billed twice.
 *
 * Deliberately NOT a database unique index. Existing rows may already contain
 * duplicates created by exactly this bug, so an index would fail to build and
 * take the migration with it; and the natural key lives inside `row_data`
 * (`application.roomChoice1`), which an index cannot read without a generated
 * column. This is the same predicate as the client's, evaluated where it cannot
 * be bypassed.
 */
export type DuplicateApplicationMatch = { id: string; row: DemoApplicantRow };

/** The room a row is for, using the same two fields the client guard reads. */
export function applicationRoomKey(row: Pick<DemoApplicantRow, "application" | "assignedRoomChoice">): string {
  return (row.application?.roomChoice1 ?? "").trim() || (row.assignedRoomChoice ?? "").trim();
}

/** The property a row is for, using the same fallback order as the submit paths. */
export function applicationPropertyKey(
  row: Pick<DemoApplicantRow, "propertyId" | "assignedPropertyId" | "application">,
): string {
  return (
    (row.propertyId ?? "").trim() ||
    (row.assignedPropertyId ?? "").trim() ||
    (row.application?.propertyId ?? "").trim()
  );
}

/**
 * An existing SUBMITTED, non-withdrawn application from the same person for the
 * same property and room — or null.
 *
 * `excludeId` is the row being written, so an edit of an existing application
 * never collides with itself. Applying to several properties, or to several
 * rooms in one property, stays allowed: only the exact pair is a duplicate.
 */
export async function findDuplicateApplication(
  db: SupabaseClient,
  params: { residentEmail: string; row: DemoApplicantRow; excludeId?: string | null },
): Promise<DuplicateApplicationMatch | null> {
  const email = params.residentEmail.trim().toLowerCase();
  const propertyId = applicationPropertyKey(params.row);
  if (!email || !propertyId) return null;

  const roomKey = applicationRoomKey(params.row);
  const exclude = (params.excludeId ?? "").trim();

  const { data, error } = await db
    .from("manager_application_records")
    .select("id, row_data")
    .eq("resident_email", email)
    .limit(200);
  if (error) return null;

  for (const record of (data ?? []) as { id: string; row_data: DemoApplicantRow }[]) {
    const row = record.row_data;
    if (!row) continue;
    if (exclude && record.id === exclude) continue;
    if (row.bucket !== "pending") continue;
    // A half-finished draft is not a duplicate — the applicant is still in it.
    if (isDraftShapedApplicationRow(row)) continue;
    if (isWithdrawnApplicationRow(row)) continue;
    if (applicationPropertyKey(row) !== propertyId) continue;
    if (applicationRoomKey(row) !== roomKey) continue;
    return { id: record.id, row };
  }
  return null;
}
