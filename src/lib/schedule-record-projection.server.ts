import "server-only";

import { linkedOwnerScopeForModule } from "@/lib/auth/co-manager-module-scope";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const PLANNED_EVENTS_RECORD_ID = "axis_admin_planned_events_v1";
export const PARTNER_INQUIRIES_RECORD_ID = "axis_admin_partner_inquiries_v1";

type Db = ReturnType<typeof createSupabaseServiceRoleClient>;
export type ScheduleRecordUser = { id: string; role: string; roles?: string[] };
type ScheduleRecord = Record<string, unknown>;
type ScheduleItem = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function object(value: unknown): ScheduleItem | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as ScheduleItem
    : null;
}

function hasRole(user: ScheduleRecordUser, role: string): boolean {
  return user.role === role || (Array.isArray(user.roles) && user.roles.includes(role));
}

function recordPayload(record: ScheduleRecord): ScheduleItem[] {
  const rowData = object(record.row_data);
  return Array.isArray(rowData?.payload)
    ? rowData.payload.filter((item): item is ScheduleItem => Boolean(object(item)))
    : [];
}

function itemPropertyId(item: ScheduleItem): string {
  return text(item.propertyId ?? item.property_id);
}

function itemManagerUserId(item: ScheduleItem): string {
  return text(item.managerUserId ?? item.manager_user_id);
}

function isStandaloneInquiry(record: ScheduleRecord): boolean {
  const type = text(record.record_type).toLowerCase();
  if (type.includes("inquir")) return true;
  const rowData = object(record.row_data);
  return text(rowData?.kind).toLowerCase() === "tour" && Boolean(itemPropertyId(rowData ?? {}));
}

function busyProjection(item: ScheduleItem): ScheduleItem {
  const allowed = [
    "id",
    "kind",
    "status",
    "propertyId",
    "property_id",
    "managerUserId",
    "manager_user_id",
    "start",
    "end",
    "startsAt",
    "endsAt",
    "starts_at",
    "ends_at",
    "proposedStart",
    "proposedEnd",
    "slotKey",
    "slotBlocked",
    "assignee",
  ];
  return Object.fromEntries(allowed.flatMap((key) => key in item ? [[key, item[key]]] : []));
}

async function propertyOwners(db: Db, propertyIds: Set<string>): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  if (propertyIds.size === 0) return owners;
  try {
    const { data, error } = await db
      .from("manager_property_records")
      .select("id, manager_user_id")
      .in("id", [...propertyIds]);
    if (error) return owners;
    for (const row of data ?? []) {
      const id = text((row as ScheduleRecord).id);
      const owner = text((row as ScheduleRecord).manager_user_id);
      if (id && owner) owners.set(id, owner);
    }
  } catch {
    // Missing ownership data must narrow shared-record access, never widen it.
  }
  return owners;
}

/**
 * Projects service-role schedule rows before they cross the HTTP boundary.
 * Shared singletons are JSON containers, so their table row cannot be the
 * authorization unit. Property ownership and an explicit calendar-read grant
 * decide each contained item. Co-managers receive free/busy fields only.
 */
export async function projectScheduleRecordsForViewer(
  db: Db,
  user: ScheduleRecordUser,
  records: ScheduleRecord[],
): Promise<ScheduleRecord[]> {
  const admin = hasRole(user, "admin");
  const manager = hasRole(user, "manager");
  const propertyIds = new Set<string>();
  for (const record of records) {
    for (const item of recordPayload(record)) {
      const propertyId = itemPropertyId(item);
      if (propertyId) propertyIds.add(propertyId);
    }
    if (isStandaloneInquiry(record)) {
      const propertyId = itemPropertyId(object(record.row_data) ?? {});
      if (propertyId) propertyIds.add(propertyId);
    }
  }

  const [owners, linked] = await Promise.all([
    propertyOwners(db, propertyIds),
    manager && !admin
      ? linkedOwnerScopeForModule(db, user.id, "calendar", "read")
      : Promise.resolve(null),
  ]);

  const maySeeItem = (item: ScheduleItem): "full" | "busy" | null => {
    if (admin) return "full";
    if (!manager) return null;
    const managerUserId = itemManagerUserId(item);
    if (managerUserId === user.id) return "full";
    const propertyId = itemPropertyId(item);
    const owner = propertyId ? owners.get(propertyId) ?? "" : "";
    if (owner === user.id) return "full";
    if (!propertyId || !owner || !linked?.propertyIdsByOwner.get(owner)?.has(propertyId)) return null;
    return "busy";
  };

  const projected: ScheduleRecord[] = [];
  for (const record of records) {
    const id = text(record.id);
    const sharedPlanned = id === PLANNED_EVENTS_RECORD_ID;
    const sharedInquiries = id === PARTNER_INQUIRIES_RECORD_ID;
    if (sharedPlanned || sharedInquiries) {
      if (!admin && !manager) continue;
      const rowData = object(record.row_data) ?? {};
      const payload = recordPayload(record).flatMap((item) => {
        const access = maySeeItem(item);
        return access === "full" ? [item] : access === "busy" ? [busyProjection(item)] : [];
      });
      // A manager needs an observed empty planned-event baseline to safely use
      // the CAS RPC. An empty inquiry singleton has no supported consumer.
      if (payload.length === 0 && !sharedPlanned) continue;
      projected.push({
        ...record,
        row_data: {
          id: text(rowData.id) || id,
          recordType: text(rowData.recordType) || text(record.record_type) || id,
          payload,
        },
      });
      continue;
    }

    if (isStandaloneInquiry(record)) {
      const item = object(record.row_data);
      const access = item ? maySeeItem(item) : null;
      if (!access || !item) continue;
      projected.push({ ...record, row_data: access === "full" ? item : busyProjection(item) });
      continue;
    }

    if (admin || text(record.manager_user_id) === user.id) projected.push(record);
  }
  return projected;
}
