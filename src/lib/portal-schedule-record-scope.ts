import {
  calendarShareAvailabilityStorageKey,
  managerPropertyAvailabilityStorageKey,
  vendorAvailabilityStorageKey,
  vendorFlexiblePreferencesStorageKey,
} from "@/lib/demo-admin-scheduling";

const MANAGER_PROPERTY_AVAIL_PREFIX = "axis_mgr_avail_slots_v2_";
const CALENDAR_SHARE_PREFIX = "axis_calendar_share_avail_";
export const ROOM_DATE_BLOCK_RECORD_TYPE = "room_date_block";
const ROOM_DATE_BLOCK_PREFIX = "axis_room_block_";

/** Id of a manager's explicit closed-dates record; the owner is in the id so reads and writes scope to them. */
export function roomDateBlockRecordId(userId: string, blockUid: string): string {
  return `${ROOM_DATE_BLOCK_PREFIX}${userId.trim()}_${blockUid}`;
}

/** True when a manager-scoped schedule record id is owned by the authenticated user. */
export function managerScheduleRecordIdOwnedByUser(
  recordId: string,
  userId: string,
  recordType: string,
): boolean {
  const id = recordId.trim();
  const uid = userId.trim();
  if (!id || !uid) return false;

  if (recordType === "manager_availability") {
    return id === `axis_admin_avail_slots_v2_admin_${uid}` || id.startsWith(`${MANAGER_PROPERTY_AVAIL_PREFIX}${uid}_`);
  }
  if (recordType === "manager_property_availability") {
    return id.startsWith(`${MANAGER_PROPERTY_AVAIL_PREFIX}${uid}_prop_`);
  }
  if (recordType === "calendar_share_settings") {
    return id.startsWith(`${CALENDAR_SHARE_PREFIX}${uid}_prop_`);
  }
  if (recordType === "vendor_availability") {
    return id === vendorAvailabilityStorageKey(uid);
  }
  if (recordType === "vendor_flexible_preferences") {
    return id === vendorFlexiblePreferencesStorageKey(uid);
  }
  if (recordType === ROOM_DATE_BLOCK_RECORD_TYPE) {
    return id.startsWith(`${ROOM_DATE_BLOCK_PREFIX}${uid}_`);
  }
  return true;
}

export function isManagerScopedScheduleRecordType(recordType: string): boolean {
  return (
    recordType === "manager_availability" ||
    recordType === "manager_property_availability" ||
    recordType === "calendar_share_settings" ||
    recordType === "vendor_availability" ||
    recordType === "vendor_flexible_preferences" ||
    recordType === ROOM_DATE_BLOCK_RECORD_TYPE
  );
}

export function vendorScheduleRecordTypes(): Array<"vendor_availability" | "vendor_flexible_preferences"> {
  return ["vendor_availability", "vendor_flexible_preferences"];
}

/** Expected storage keys for a manager + property (used to validate reads). */
export function expectedManagerScheduleRecordIds(userId: string, propertyId: string): {
  shareKey: string;
  availKey: string;
} {
  return {
    shareKey: calendarShareAvailabilityStorageKey(userId, propertyId),
    availKey: managerPropertyAvailabilityStorageKey(userId, propertyId),
  };
}
