import { after } from "next/server";
import { createJsonRecordRoute } from "@/lib/portal-record-api";
import {
  isManagerScopedScheduleRecordType,
  managerScheduleRecordIdOwnedByUser,
  vendorScheduleRecordTypes,
} from "@/lib/portal-schedule-record-scope";
import { syncManagerAvailabilityToGoogleCalendar } from "@/lib/google-calendar/sync.server";
import { summarizeAvailabilityChange } from "@/lib/availability-change-summary";
import { resolvePropertyOwnerUserId } from "@/lib/property-owner.server";
import { emitAvailabilityChangedEvent } from "@/lib/tour-events.server";
import { replaceManagerPlannedScheduleSlice } from "@/lib/planned-schedule-persistence.server";
import {
  PARTNER_INQUIRIES_RECORD_ID,
  PLANNED_EVENTS_RECORD_ID,
  projectScheduleRecordsForViewer,
} from "@/lib/schedule-record-projection.server";

export const runtime = "nodejs";

/**
 * WS3: painted tour availability lands on the manager's Google Calendar as
 * free ("Open for tours") blocks; WS5: the change is announced to the team
 * that shares the property. Both record types are manager-scoped (see
 * `isManagerScopedScheduleRecordType`), so `record.manager_user_id` is always
 * the authenticated manager by the time `afterWrite` runs.
 */
const AVAILABILITY_RECORD_TYPES = new Set(["manager_availability", "manager_property_availability"]);

/**
 * The team notice goes to the PROPERTY OWNER's team when the record is about
 * one house (a co-manager's availability on the owner's house is the owner's
 * team's news), else to the writer's own team. Idempotent on what changed,
 * so a retried save never re-posts.
 */
async function announceAvailabilityChange(input: {
  db: Parameters<typeof emitAvailabilityChangedEvent>[0];
  managerUserId: string;
  recordId: string;
  propertyId: string | null;
  rowData: unknown;
  previousRowData: unknown;
}): Promise<void> {
  const change = summarizeAvailabilityChange(input.previousRowData, input.rowData);
  if (!change) return;
  const owner = (await resolvePropertyOwnerUserId(input.db, input.propertyId)) ?? input.managerUserId;
  await emitAvailabilityChangedEvent(input.db, {
    managerUserId: owner,
    changedByUserId: input.managerUserId,
    summary: change.summary,
    entityId: input.recordId,
    propertyId: input.propertyId,
    changeKey: change.changeKey,
  });
}

type PlannedEventValue = Record<string, unknown>;

function plannedEventsFromRow(row: Record<string, unknown> | null | undefined): PlannedEventValue[] {
  const rowData = row?.row_data;
  if (!rowData || typeof rowData !== "object" || Array.isArray(rowData)) return [];
  const payload = (rowData as Record<string, unknown>).payload;
  return Array.isArray(payload)
    ? payload.filter(
        (item): item is PlannedEventValue =>
          Boolean(item && typeof item === "object" && !Array.isArray(item)),
      )
    : [];
}

function plannedEventId(event: PlannedEventValue): string {
  return typeof event.id === "string" ? event.id.trim() : String(event.id ?? "").trim();
}

function plannedEventOwner(event: PlannedEventValue): string {
  return typeof event.managerUserId === "string" ? event.managerUserId.trim() : "";
}

function isTourPlannedEvent(event: PlannedEventValue): boolean {
  return typeof event.kind === "string" && event.kind.trim() === "tour";
}

const route = createJsonRecordRoute({
  table: "portal_schedule_records",
  readRecords: async ({ db }) => {
    const { data, error } = await db
      .from("portal_schedule_records")
      .select("id, manager_user_id, property_id, record_type, row_data, updated_at")
      .order("updated_at", { ascending: false })
      .limit(500);
    return { data: data as Record<string, unknown>[] | null, error };
  },
  projectRead: async ({ db, user, records }) => projectScheduleRecordsForViewer(db, user, records),
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
  atomicWrite: async ({ db, user, record, existing, expectedPayload, expectedPayloadKnown }) => {
    if (String(record.id) !== PLANNED_EVENTS_RECORD_ID) {
      return { handled: false };
    }
    const rowData = record.row_data;
    const payload = rowData && typeof rowData === "object" && !Array.isArray(rowData)
      ? (rowData as { payload?: unknown }).payload
      : [];
    const existingEvents = plannedEventsFromRow(existing);
    const existingById = new Map(
      existingEvents
        .map((event) => [plannedEventId(event), event] as const)
        .filter(([id]) => Boolean(id)),
    );

    const events = (Array.isArray(payload) ? payload : [])
      .filter(
        (item): item is Record<string, unknown> =>
          Boolean(item && typeof item === "object" && !Array.isArray(item)),
      )
      .filter((item) => {
        const id = plannedEventId(item);
        const stored = id ? existingById.get(id) : undefined;
        // Tours are lifecycle-owned by their dedicated cancel/reschedule routes,
        // even for admins. A generic snapshot can never delete or rewrite one.
        if (isTourPlannedEvent(item) || (stored && isTourPlannedEvent(stored))) return false;
        if (user.role === "admin") return true;
        if (stored && plannedEventOwner(stored) !== user.id) return false;
        const claimedOwner = plannedEventOwner(item);
        return !claimedOwner || claimedOwner === user.id;
      })
      .map((item) => user.role === "admin" ? item : ({ ...item, managerUserId: user.id }));

    const expectedPayloadValue = expectedPayloadKnown && Array.isArray(expectedPayload)
      ? expectedPayload
      : null;
    const expectedEvents = expectedPayloadValue
      ? expectedPayloadValue
          .filter(
            (item): item is Record<string, unknown> =>
              Boolean(item && typeof item === "object" && !Array.isArray(item)),
          )
          .filter((item) => !isTourPlannedEvent(item))
          .filter((item) => user.role === "admin" || plannedEventOwner(item) === user.id)
      : null;
    const result = await replaceManagerPlannedScheduleSlice(db, {
      managerUserId: user.id,
      actorIsAdmin: user.role === "admin",
      events,
      expectedEvents,
    });
    // A manager's shared snapshot cannot safely fall back to an ordinary
    // upsert: an old database would otherwise reopen the exact lost-booking
    // race this transaction boundary is meant to close.
    if (!result.available) {
      return { handled: true, error: "Calendar write is unavailable. Refresh and try again.", status: 503 };
    }
    if (!result.ok) return { handled: true, error: result.reason, status: 409 };
    return { handled: true };
  },
  authorizeDelete: async ({ records }) => {
    if (records.some((record) => {
      const id = String(record.id ?? "").trim();
      return id === PLANNED_EVENTS_RECORD_ID || id === PARTNER_INQUIRIES_RECORD_ID;
    })) {
      return {
        ok: false,
        error: "Shared calendar and inquiry records must be changed through their dedicated lifecycle routes.",
      };
    }
    return { ok: true };
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
  afterWrite: async ({ record, existing, db }) => {
    const recordType = String(record.record_type ?? "");
    if (!AVAILABILITY_RECORD_TYPES.has(recordType)) return;
    const managerUserId = String(record.manager_user_id ?? "").trim();
    const recordId = String(record.id ?? "").trim();
    if (!managerUserId || !recordId) return;
    const propertyId = String(record.property_id ?? "").trim() || null;
    const previousRowData = existing?.row_data ?? null;
    const task = () =>
      Promise.all([
        syncManagerAvailabilityToGoogleCalendar(db, managerUserId, {
          recordId,
          rowData: record.row_data,
          previousRowData,
        }).catch((e) => console.warn("[google-calendar] availability push failed", e)),
        announceAvailabilityChange({
          db,
          managerUserId,
          recordId,
          propertyId,
          rowData: record.row_data,
          previousRowData,
        }).catch((e) => console.warn("[team-comms] availability change notice failed", e)),
      ]);
    try {
      after(task);
    } catch {
      void task();
    }
  },
});

export const GET = route.GET;
export const POST = route.POST;
