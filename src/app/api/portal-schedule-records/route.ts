import { createJsonRecordRoute } from "@/lib/portal-record-api";
import {
  isManagerScopedScheduleRecordType,
  managerScheduleRecordIdOwnedByUser,
  vendorScheduleRecordTypes,
} from "@/lib/portal-schedule-record-scope";
import { reconcileManagerPlannedEventsWrite } from "@/lib/planned-events-write-scope";

export const runtime = "nodejs";

const route = createJsonRecordRoute({
  table: "portal_schedule_records",
  scope: (query, user) => {
    const q = query as {
      eq: (column: string, value: string) => unknown;
      or: (filters: string) => unknown;
    };
    if (user.role === "admin") return query;
    if (user.role === "vendor") {
      return q.or(
        `manager_user_id.eq.${user.id},id.eq.axis_vendor_avail_slots_v2_${user.id},id.eq.axis_vendor_flex_prefs_${user.id}`,
      );
    }
    return q.or(
      `manager_user_id.eq.${user.id},id.like.axis_mgr_avail_slots_v2_${user.id}%,id.like.axis_calendar_share_avail_${user.id}_prop_%,id.like.axis_manager_tasks_v1_${user.id},id.eq.axis_admin_partner_inquiries_v1,id.eq.axis_admin_planned_events_v1`,
    );
  },
  buildUpsert: (row, user) => {
    const recordType = String(row.recordType ?? row.record_type ?? "event");
    return {
      id: row.id,
      // Only an admin may attribute a row to another owner (or leave it null for
      // shared singletons, which are scoped by fixed id, not owner). EVERY
      // non-admin write is pinned to the caller — otherwise a client could set
      // manager_user_id to a victim manager and plant rows on their calendar for
      // any record type outside the manager-scoped allowlist (e.g. "event").
      manager_user_id:
        user.role === "admin" ? (row.managerUserId ?? row.manager_user_id ?? null) : user.id,
      property_id: row.propertyId ?? row.property_id ?? null,
      record_type: recordType,
      starts_at: row.startsAt ?? row.starts_at ?? row.startIso ?? null,
      ends_at: row.endsAt ?? row.ends_at ?? row.endIso ?? null,
      row_data: row,
      updated_at: new Date().toISOString(),
    };
  },
  assignOwnership: (record, user) => {
    if (user.role === "admin") return record;
    if (user.role === "vendor") return { ...record, manager_user_id: user.id };
    const recordType = String(record.record_type ?? "");
    const managerScoped = isManagerScopedScheduleRecordType(recordType);
    // Only stamp ownership on manager-scoped types; shared singleton records
    // (partner inquiries, planned events) keep their existing owner handling.
    return managerScoped ? { ...record, manager_user_id: user.id } : record;
  },
  reconcileExisting: (record, user, existing) => {
    if (user.role === "admin" || String(record.id) !== "axis_admin_planned_events_v1") {
      return record;
    }
    return reconcileManagerPlannedEventsWrite(record, user.id, existing);
  },
  assertInsertAllowed: (record, user) => {
    if (user.role === "admin") return null;
    const recordType = String(record.record_type ?? "");
    if (user.role === "vendor") {
      if (!vendorScheduleRecordTypes().includes(recordType as "vendor_availability" | "vendor_flexible_preferences")) {
        return "Vendors can only update their own availability records.";
      }
      const id = String(record.id ?? "");
      if (!managerScheduleRecordIdOwnedByUser(id, user.id, recordType)) {
        return "Record id must belong to the authenticated vendor.";
      }
      return null;
    }
    if (!isManagerScopedScheduleRecordType(recordType)) return null;
    const id = String(record.id ?? "");
    if (!managerScheduleRecordIdOwnedByUser(id, user.id, recordType)) {
      return "Record id must belong to the authenticated manager.";
    }
    return null;
  },
});

export const GET = route.GET;
export const POST = route.POST;
