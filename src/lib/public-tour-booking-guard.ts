import "server-only";

import { filterAdminUserIds } from "@/lib/auth/admin-role";
import { listPropertyTourHostUserIds } from "@/lib/tour-host-enumeration.server";
import { resolveTourOfferingSlots } from "@/lib/tour-slot-math";
import type { SupabaseClient } from "@supabase/supabase-js";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function payloadSlots(rowData: unknown): string[] {
  if (!rowData || typeof rowData !== "object" || Array.isArray(rowData)) return [];
  const payload = (rowData as Record<string, unknown>).payload;
  return Array.isArray(payload) ? payload.filter((item): item is string => typeof item === "string") : [];
}

/**
 * May this manager be the host of a tour on this property?
 *
 * Owner of the LIVE property, or an accepted co-manager who was assigned that
 * property and may act on it. Nothing else — in particular, **publishing
 * availability against a property id confers nothing**.
 *
 * That used to be the second half of this predicate, and it was a hole rather
 * than a convenience: `manager_property_availability` rows are written by the
 * manager themselves, so anyone who knew a property id could write a row naming
 * it and become a bookable host on somebody else's house — taking their tours,
 * their prospects' contact details, and a slot on their calendar. The public
 * booking route calls this with a host supplied by the browser, so it is the
 * only thing standing between a stranger and that house.
 *
 * Permission is read at either `calendar` or `applications` edit, because those
 * are the two grants that already imply tour work today (the Tours nav section
 * is gated on `applications`, the calendar on `calendar`) — narrowing to one
 * would silently remove hosting from co-managers who have it now.
 */
export async function managerMayHostPropertyTour(
  db: SupabaseClient,
  input: { managerUserId: string; propertyId: string },
): Promise<boolean> {
  const managerUserId = input.managerUserId.trim();
  const propertyId = input.propertyId.trim();
  if (!managerUserId || !propertyId) return false;

  const { data: propertyRow } = await db
    .from("manager_property_records")
    .select("manager_user_id, status")
    .eq("id", propertyId)
    .maybeSingle();

  if (!propertyRow) return false;
  if (text(propertyRow.status).toLowerCase() !== "live") return false;

  const ownerUserId = text(propertyRow.manager_user_id);
  if (!ownerUserId) return false;
  if (ownerUserId === managerUserId) return true;

  // WS4(shared-avail): the co-manager half now reuses the same roster
  // `listOpenTourSlots` and `createTourInquiry` enumerate, so a single-candidate
  // check here can never drift from the full host list computed elsewhere.
  const hostUserIds = await listPropertyTourHostUserIds(db, { propertyId, ownerUserId });
  return hostUserIds.includes(managerUserId);
}

/** True when slotKey appears in the manager's published availability rows. */
export async function managerHasPublishedSlot(
  db: SupabaseClient,
  input: { managerUserId: string; slotKey: string; propertyId?: string | null },
): Promise<boolean> {
  const managerUserId = input.managerUserId.trim();
  const slotKey = input.slotKey.trim();
  const propertyId = input.propertyId?.trim() ?? "";
  if (!managerUserId || !slotKey) return false;

  const { data: rows } = await db
    .from("portal_schedule_records")
    .select("property_id, record_type, row_data")
    .eq("manager_user_id", managerUserId)
    .in("record_type", ["manager_property_availability", "manager_availability"]);

  const published: string[] = [];
  for (const row of rows ?? []) {
    if (propertyId && row.record_type === "manager_property_availability" && text(row.property_id) !== propertyId) {
      continue;
    }
    published.push(...payloadSlots(row.row_data));
  }
  return resolveTourOfferingSlots(published).includes(slotKey);
}

/** True when an admin-role account publishes the slot in admin availability. */
export async function adminHasPublishedSlot(
  db: SupabaseClient,
  input: { adminUserId: string; slotKey: string },
): Promise<boolean> {
  const adminUserId = input.adminUserId.trim();
  const slotKey = input.slotKey.trim();
  if (!adminUserId || !slotKey) return false;

  const adminIds = await filterAdminUserIds(db, [adminUserId]);
  if (!adminIds.has(adminUserId)) return false;

  const { data: rows } = await db
    .from("portal_schedule_records")
    .select("row_data")
    .eq("record_type", "admin_availability");

  for (const row of rows ?? []) {
    if (payloadSlots(row.row_data).includes(slotKey)) return true;
  }
  return false;
}
