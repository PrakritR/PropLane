import "server-only";

import { asStringArray, readPropertyPermissionsFromRow } from "@/lib/account-link-invite-row";
import { filterAdminUserIds } from "@/lib/auth/admin-role";
import { hasCoManagerPermissionLevelForProperty } from "@/lib/co-manager-permissions";
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

  return coManagerMayHostPropertyTour(db, { managerUserId, propertyId, ownerUserId });
}

/**
 * The co-manager half, split out so the ownership fast path costs one read.
 * Any failure to read the link table answers NO — a host is a person who takes
 * a stranger to a house, so an unreadable grant is not a grant.
 */
async function coManagerMayHostPropertyTour(
  db: SupabaseClient,
  input: { managerUserId: string; propertyId: string; ownerUserId: string },
): Promise<boolean> {
  try {
    const { data: links, error } = await db
      .from("account_link_invites")
      .select(
        "invitee_user_id, assigned_property_ids, property_co_manager_permissions, co_manager_permissions",
      )
      .eq("status", "accepted")
      .eq("inviter_user_id", input.ownerUserId)
      .eq("invitee_user_id", input.managerUserId);

    if (error) return false;

    for (const row of links ?? []) {
      if (!asStringArray(row.assigned_property_ids).includes(input.propertyId)) continue;
      const permissions = readPropertyPermissionsFromRow(
        row as Parameters<typeof readPropertyPermissionsFromRow>[0],
      );
      const mayAct =
        hasCoManagerPermissionLevelForProperty(permissions, input.propertyId, "calendar", "edit") ||
        hasCoManagerPermissionLevelForProperty(permissions, input.propertyId, "applications", "edit");
      if (mayAct) return true;
    }
  } catch {
    // The link table may not exist in every environment; absent grants are no grants.
    return false;
  }

  return false;
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
