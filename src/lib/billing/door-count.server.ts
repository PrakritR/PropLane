import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  LISTING_SLOT_PROPERTY_STATUSES,
  type ManagerPropertyRecordStatus,
} from "@/lib/persisted-property-records";
import { doorCountForListing, type DoorCountBasis } from "@/lib/billing/door-count";

/**
 * Server-side door count for one manager account — the portfolio total AND a
 * per-listing breakdown, so a bill can be explained line by line.
 *
 * Billable listings are exactly the ones that occupy a listing slot today —
 * `LISTING_SLOT_PROPERTY_STATUSES` (`pending`, `live`, `review`), the same set
 * `assertManagerPropertyListingQuota` (`manager-property-quota.server.ts`) caps
 * and `propertyRowsToSnapshot` mirrors into the portal's own counts. A deleted,
 * draft, unlisted, rejected or request-change row never bills: a draft is
 * private and unpublished, and the others are listings the manager already
 * took down or never finished.
 */

export type ListingDoorBreakdown = {
  propertyId: string;
  label: string;
  doors: number;
  basis: DoorCountBasis;
};

export type ManagerDoorCountResult =
  | { ok: true; totalDoors: number; breakdown: ListingDoorBreakdown[] }
  | { ok: false; error: string };

type BillableManagerPropertyRow = {
  id: string;
  status: ManagerPropertyRecordStatus;
  row_data: unknown;
  property_data: unknown;
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/**
 * The listing submission a row's door count is computed from.
 *
 * A `pending` record's submission lives at `row_data.submission`
 * (`ManagerPendingPropertyRow.submission`); a `live`/`review` record's lives at
 * `property_data.listingSubmission` (`MockProperty.listingSubmission`) — the
 * same two locations `propertyRowsToSnapshot` reads to build the portal's own
 * pipeline view. Neither is guaranteed present, and `doorCountForListing`
 * already treats an absent/malformed submission as "no rooms recorded".
 */
function submissionForRow(row: BillableManagerPropertyRow): unknown {
  if (row.status === "pending") {
    return asObject(row.row_data)?.submission;
  }
  return asObject(row.property_data)?.listingSubmission;
}

/** A human label for the breakdown line — never authoritative, display only. */
function labelForRow(row: BillableManagerPropertyRow): string {
  const source = row.status === "pending" ? asObject(row.row_data) : asObject(row.property_data);
  const buildingName = typeof source?.buildingName === "string" ? source.buildingName.trim() : "";
  if (buildingName) return buildingName;
  const address = typeof source?.address === "string" ? source.address.trim() : "";
  if (address) return address;
  return `Listing ${row.id}`;
}

/**
 * Portfolio door total for one manager account, plus the per-listing
 * breakdown behind it. Reads live rows straight from `manager_property_records`
 * — this is the LIVE count. Billing itself must read the snapshot table this
 * function feeds (`door-count-snapshot.server.ts`), never this directly, so a
 * mid-cycle listing edit can never move a bill already issued.
 */
export async function loadManagerDoorCount(
  db: SupabaseClient,
  managerUserId: string,
): Promise<ManagerDoorCountResult> {
  const trimmed = managerUserId.trim();
  if (!trimmed) return { ok: false, error: "managerUserId is required" };

  const { data, error } = await db
    .from("manager_property_records")
    .select("id, status, row_data, property_data")
    .eq("manager_user_id", trimmed)
    .in("status", [...LISTING_SLOT_PROPERTY_STATUSES]);

  // A failed read must never be read as "zero doors" — that would silently
  // undercharge (or refuse a bill) on exactly the transient error this ought
  // to survive, same discipline as `countManagerListingSlots`.
  if (error) return { ok: false, error: error.message };

  const rows = (data ?? []) as BillableManagerPropertyRow[];
  const breakdown: ListingDoorBreakdown[] = rows.map((row) => {
    const { doors, basis } = doorCountForListing(submissionForRow(row));
    return { propertyId: row.id, label: labelForRow(row), doors, basis };
  });

  const totalDoors = breakdown.reduce((sum, entry) => sum + entry.doors, 0);
  return { ok: true, totalDoors, breakdown };
}
