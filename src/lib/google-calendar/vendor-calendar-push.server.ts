import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import {
  createGoogleCalendarEvent,
  deleteGoogleCalendarEvent,
  updateGoogleCalendarEvent,
} from "@/lib/google-calendar/api.server";
import { PROPLANE_GOOGLE_CALENDAR_MARKER, PROPLANE_WORK_ORDER_TYPE_MARKER } from "@/lib/google-calendar/markers";
import { loadGoogleCalendarConnection } from "@/lib/google-calendar/settings";
import { mergeTourAvailabilitySlotsIntoWindows, payloadSlots } from "@/lib/tour-slot-math";

/**
 * Duplicated in full from `sync.server.ts` rather than imported: that module
 * imports THIS one (to push the vendor leg after the manager leg), so an
 * import the other way would be circular. Both are small and stable — keep
 * them in sync with `sync.server.ts`'s own copies if either ever changes.
 */
const SERVICE_VISIT_DURATION_MINUTES = 60;
function workOrderShouldSyncToGoogleCalendar(row: DemoManagerWorkOrderRow): boolean {
  if (row.bucket === "completed" || !row.scheduledAtIso) return false;
  return row.bucket === "scheduled" || Boolean(row.scheduledAtIso);
}

/**
 * Two vendor-side pushes to the VENDOR's OWN connected Google Calendar,
 * distinct from `sync.server.ts`'s manager-side push (which targets the
 * MANAGER's calendar and already existed). Both are gated on the new
 * `connection.vendorPushEnabled` flag, default OFF — a vendor who only wants
 * their Google busy time read into PropLane (the pre-existing, read-only
 * behavior) must see nothing new written to their calendar until they opt in
 * from the vendor Calendar page.
 *
 * Best-effort throughout: every function swallows its own Google Calendar
 * errors rather than throwing, matching `syncWorkOrderToGoogleCalendar`'s own
 * contract — a vendor's Google Calendar push is never allowed to fail a work
 * order assignment or a manager's own sync.
 */

function visitTitle(row: DemoManagerWorkOrderRow): string {
  return `Service visit · ${row.title}`;
}

function visitDescription(row: DemoManagerWorkOrderRow): string {
  return [
    PROPLANE_WORK_ORDER_TYPE_MARKER,
    `Work order: ${row.id}`,
    row.propertyName?.trim() ? `Property: ${row.propertyName.trim()}` : null,
    row.residentName?.trim() ? `Resident: ${row.residentName.trim()}` : null,
    row.description?.trim() ? `Details: ${row.description.trim()}` : null,
    PROPLANE_GOOGLE_CALENDAR_MARKER,
  ]
    .filter(Boolean)
    .join("\n");
}

function visitEndIso(row: DemoManagerWorkOrderRow): string | null {
  if (!row.scheduledAtIso) return null;
  const start = new Date(row.scheduledAtIso);
  if (Number.isNaN(start.getTime())) return null;
  return new Date(start.getTime() + SERVICE_VISIT_DURATION_MINUTES * 60_000).toISOString();
}

function propertyLabel(row: DemoManagerWorkOrderRow): string | undefined {
  const unit = row.unit?.trim();
  if (unit && unit !== "—") return `${row.propertyName} · ${unit}`;
  return row.propertyName?.trim() || undefined;
}

/**
 * Push, update, or remove a vendor's own assigned service visit on THEIR
 * connected Google Calendar. No-op (returns the row unchanged) whenever the
 * vendor is not connected, sync is off, or `vendorPushEnabled` is off — so
 * every call site can invoke this unconditionally without checking those
 * gates itself, the same contract `syncWorkOrderToGoogleCalendar` follows for
 * the manager side.
 */
export async function syncVendorServiceVisitToGoogleCalendar(
  db: SupabaseClient,
  vendorUserId: string | null | undefined,
  row: DemoManagerWorkOrderRow,
): Promise<DemoManagerWorkOrderRow> {
  const vendorId = vendorUserId?.trim();
  if (!vendorId) return row;

  let connection;
  try {
    connection = await loadGoogleCalendarConnection(db, vendorId);
  } catch {
    return row;
  }
  if (!connection.connected || !connection.syncEnabled || !connection.vendorPushEnabled) return row;

  const existingEventId = row.vendorGoogleCalendarEventId?.trim() || null;
  if (!workOrderShouldSyncToGoogleCalendar(row)) {
    if (existingEventId) {
      await deleteGoogleCalendarEvent(db, vendorId, existingEventId).catch(() => undefined);
      const rest = { ...row };
      delete rest.vendorGoogleCalendarEventId;
      return rest;
    }
    return row;
  }

  const endIso = visitEndIso(row);
  if (!row.scheduledAtIso || !endIso) return row;

  const input = {
    title: visitTitle(row),
    description: visitDescription(row),
    start: row.scheduledAtIso,
    end: endIso,
    location: propertyLabel(row),
  };

  try {
    const vendorGoogleCalendarEventId = existingEventId
      ? await updateGoogleCalendarEvent(db, vendorId, existingEventId, input).catch(() =>
          createGoogleCalendarEvent(db, vendorId, input),
        )
      : await createGoogleCalendarEvent(db, vendorId, input);
    if (!vendorGoogleCalendarEventId) return row;
    return vendorGoogleCalendarEventId === existingEventId ? row : { ...row, vendorGoogleCalendarEventId };
  } catch {
    return row;
  }
}

/** Server-owned state row tracking what a vendor's availability push last put on Google. */
function vendorAvailabilityPushStateRecordId(vendorUserId: string): string {
  return `axis_gcal_vendor_avail_push_${vendorUserId.trim()}`;
}

const MAX_VENDOR_AVAILABILITY_WINDOWS_PER_PUSH = 60;

/**
 * Push a vendor's painted availability slots (`vendorAvailabilityStorageKey`,
 * `src/lib/vendor-availability-server.ts`) to Google as "Available"
 * transparent (free) events — the vendor counterpart of
 * `syncManagerAvailabilityToGoogleCalendar`. Diff-free by design, same
 * rationale as that function: every previously-pushed id is deleted and the
 * current slot set recreated, because this runs on an explicit vendor save,
 * not a hot loop.
 *
 * Simpler than the manager version deliberately: a vendor's own availability
 * save has no cross-manager contention, so this skips the CAS lock/retry-pass
 * machinery `syncManagerAvailabilityToGoogleCalendar` needs and does one pass.
 */
export async function syncVendorAvailabilityToGoogleCalendar(
  db: SupabaseClient,
  vendorUserId: string,
  slotKeys: readonly string[],
): Promise<void> {
  const vendorId = vendorUserId.trim();
  if (!vendorId) return;
  let connection;
  try {
    connection = await loadGoogleCalendarConnection(db, vendorId);
  } catch {
    return;
  }
  if (!connection.connected || !connection.syncEnabled || !connection.vendorPushEnabled) return;

  const stateId = vendorAvailabilityPushStateRecordId(vendorId);
  const { data: stateRow } = await db.from("portal_schedule_records").select("row_data").eq("id", stateId).maybeSingle();
  const previousIds = Array.isArray((stateRow?.row_data as { eventIds?: unknown })?.eventIds)
    ? ((stateRow?.row_data as { eventIds?: unknown[] }).eventIds as unknown[]).filter(
        (id): id is string => typeof id === "string" && id.trim().length > 0,
      )
    : [];

  for (const id of previousIds) {
    await deleteGoogleCalendarEvent(db, vendorId, id).catch(() => undefined);
  }

  const windows = mergeTourAvailabilitySlotsIntoWindows(payloadSlots({ payload: slotKeys }));
  const boundedWindows = windows.slice(0, MAX_VENDOR_AVAILABILITY_WINDOWS_PER_PUSH);
  const newIds: string[] = [];
  for (const window of boundedWindows) {
    const id = await createGoogleCalendarEvent(db, vendorId, {
      title: "Available",
      description: [PROPLANE_GOOGLE_CALENDAR_MARKER, "Type: vendor-availability"].join("\n"),
      start: window.start,
      end: window.end,
      transparency: "transparent",
    }).catch(() => null);
    if (id) newIds.push(id);
  }

  await db.from("portal_schedule_records").upsert(
    {
      id: stateId,
      manager_user_id: vendorId,
      property_id: null,
      record_type: "google_vendor_availability_push",
      row_data: { eventIds: newIds },
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
}
