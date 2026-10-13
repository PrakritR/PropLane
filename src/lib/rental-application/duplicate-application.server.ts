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

export type ResidentListingApplications = {
  /** Live SUBMITTED applications by room choice value — the duplicate answer. */
  byRoom: Map<string, DuplicateApplicationMatch>;
  /**
   * Live (non-withdrawn) DRAFTS by room choice value. Not duplicates — the applicant is still in them —
   * but a path that starts a fresh application for a room must resume the draft it already has there
   * instead of minting a second one: nothing downstream can see it as a duplicate, and the fee claim a
   * draft collects is keyed on its application id, so a new id would also orphan the payment.
   */
  draftsByRoom: Map<string, DuplicateApplicationMatch>;
};

/**
 * One read of everything this person has on one listing, split into live submitted applications and
 * live drafts, both keyed by the same room choice value the rows carry. One read answers for the whole
 * listing, so a caller weighing several rooms (Quick apply deciding which room to judge a verdict on, and
 * which draft to resume) never asks once per room.
 *
 * `excludeId` is the row being written, so an edit of an existing application never collides with itself.
 */
export async function findResidentApplicationsForListing(
  db: SupabaseClient,
  params: { residentEmail: string; propertyId: string; excludeId?: string | null },
): Promise<ResidentListingApplications> {
  const byRoom = new Map<string, DuplicateApplicationMatch>();
  const draftsByRoom = new Map<string, DuplicateApplicationMatch>();
  const email = params.residentEmail.trim().toLowerCase();
  const propertyId = params.propertyId.trim();
  if (!email || !propertyId) return { byRoom, draftsByRoom };

  const exclude = (params.excludeId ?? "").trim();
  const { data, error } = await db
    .from("manager_application_records")
    .select("id, row_data")
    .eq("resident_email", email)
    .limit(200);
  if (error) return { byRoom, draftsByRoom };

  for (const record of (data ?? []) as { id: string; row_data: DemoApplicantRow }[]) {
    const row = record.row_data;
    if (!row) continue;
    if (exclude && record.id === exclude) continue;
    if (row.bucket !== "pending") continue;
    if (isWithdrawnApplicationRow(row)) continue;
    if (applicationPropertyKey(row) !== propertyId) continue;
    const roomKey = applicationRoomKey(row);
    // A half-finished draft is not a duplicate — the applicant is still in it.
    const target = isDraftShapedApplicationRow(row) ? draftsByRoom : byRoom;
    if (!target.has(roomKey)) target.set(roomKey, { id: record.id, row });
  }
  return { byRoom, draftsByRoom };
}

/**
 * Every room of one property this person already has a live SUBMITTED application for.
 * {@link findResidentApplicationsForListing} is the same read when the drafts matter too.
 */
export async function findDuplicateApplicationsByRoom(
  db: SupabaseClient,
  params: { residentEmail: string; propertyId: string; excludeId?: string | null },
): Promise<Map<string, DuplicateApplicationMatch>> {
  return (await findResidentApplicationsForListing(db, params)).byRoom;
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
  const byRoom = await findDuplicateApplicationsByRoom(db, {
    residentEmail: params.residentEmail,
    propertyId: applicationPropertyKey(params.row),
    excludeId: params.excludeId,
  });
  return byRoom.get(applicationRoomKey(params.row)) ?? null;
}
