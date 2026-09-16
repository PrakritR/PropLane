import type { SupabaseClient } from "@supabase/supabase-js";

import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import {
  createGoogleCalendarEvent,
  deleteGoogleCalendarEvent,
  updateGoogleCalendarEvent,
} from "@/lib/google-calendar/api.server";
import { loadGoogleCalendarConnection } from "@/lib/google-calendar/settings";
import { mergeTourAvailabilitySlotsIntoWindows, payloadSlots } from "@/lib/tour-slot-math";

import {
  PROPLANE_AVAILABILITY_TYPE_MARKER,
  PROPLANE_GOOGLE_CALENDAR_MARKER,
  PROPLANE_TOUR_TYPE_MARKER,
  PROPLANE_WORK_ORDER_TYPE_MARKER,
} from "@/lib/google-calendar/markers";

const PLANNED_RECORD_ID = "axis_admin_planned_events_v1";
const SERVICE_VISIT_DURATION_MINUTES = 60;

type GoogleCalendarUpsertInput = {
  title: string;
  description: string;
  start: string;
  end: string;
  location?: string;
  googleCalendarEventId?: string | null;
};

async function upsertGoogleCalendarEvent(
  db: SupabaseClient,
  managerUserId: string,
  input: GoogleCalendarUpsertInput,
): Promise<string | null> {
  const connection = await loadGoogleCalendarConnection(db, managerUserId);
  if (!connection.connected || !connection.syncEnabled) return null;

  const existingId = input.googleCalendarEventId?.trim() || null;
  if (existingId) {
    try {
      return await updateGoogleCalendarEvent(db, managerUserId, existingId, input);
    } catch {
      // Stale or deleted remote event — fall through to create.
    }
  }
  return createGoogleCalendarEvent(db, managerUserId, input);
}

function rowsFromPlannedRecord(rowData: unknown): Record<string, unknown>[] {
  if (!rowData || typeof rowData !== "object") return [];
  const payload = (rowData as { payload?: unknown }).payload;
  return Array.isArray(payload) ? payload.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === "object")) : [];
}

export async function persistPlannedEventGoogleCalendarId(
  db: SupabaseClient,
  plannedEventId: string,
  googleCalendarEventId: string | null,
): Promise<void> {
  const id = plannedEventId.trim();
  if (!id) return;
  const { data: plannedRecord, error: readError } = await db
    .from("portal_schedule_records")
    .select("row_data")
    .eq("id", PLANNED_RECORD_ID)
    .maybeSingle();
  if (readError || !plannedRecord?.row_data) return;

  const plannedRows = rowsFromPlannedRecord(plannedRecord.row_data);
  let changed = false;
  const nextRows = plannedRows.map((row) => {
    if (String(row.id ?? "") !== id) return row;
    changed = true;
    if (googleCalendarEventId) {
      return { ...row, googleCalendarEventId };
    }
    const { googleCalendarEventId: _removed, ...rest } = row;
    return rest;
  });
  if (!changed) return;

  const rowData = plannedRecord.row_data as Record<string, unknown>;
  const { error: writeError } = await db.from("portal_schedule_records").upsert(
    {
      id: PLANNED_RECORD_ID,
      manager_user_id: null,
      property_id: (rowData.propertyId as string | null) ?? null,
      record_type: PLANNED_RECORD_ID,
      row_data: { ...rowData, payload: nextRows },
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
  if (writeError) throw new Error(writeError.message);
}

function buildTourDescription(event: {
  attendeeName?: string;
  attendeeEmail?: string;
  attendeePhone?: string;
  notes?: string;
  instructions?: string;
}): string {
  return [
    PROPLANE_TOUR_TYPE_MARKER,
    event.attendeeName ? `Guest: ${event.attendeeName}` : null,
    event.attendeeEmail ? `Email: ${event.attendeeEmail}` : null,
    event.attendeePhone ? `Phone: ${event.attendeePhone}` : null,
    event.notes ? `Notes: ${event.notes}` : null,
    event.instructions ? `Instructions: ${event.instructions}` : null,
    PROPLANE_GOOGLE_CALENDAR_MARKER,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Best-effort push or update of a confirmed PropLane tour on the manager's Google Calendar. */
export async function syncPlannedTourToGoogleCalendar(
  db: SupabaseClient,
  managerUserId: string,
  event: {
    plannedEventId: string;
    title: string;
    start: string;
    end: string;
    propertyTitle?: string;
    attendeeName?: string;
    attendeeEmail?: string;
    attendeePhone?: string;
    notes?: string;
    instructions?: string;
    googleCalendarEventId?: string | null;
  },
): Promise<string | null> {
  const googleCalendarEventId = await upsertGoogleCalendarEvent(db, managerUserId, {
    title: event.title,
    description: buildTourDescription(event),
    start: event.start,
    end: event.end,
    location: event.propertyTitle,
    googleCalendarEventId: event.googleCalendarEventId,
  });
  if (googleCalendarEventId) {
    await persistPlannedEventGoogleCalendarId(db, event.plannedEventId, googleCalendarEventId).catch(() => undefined);
  }
  return googleCalendarEventId;
}

function workOrderCalendarTitle(row: DemoManagerWorkOrderRow): string {
  if (row.selfAssigned) return `My work · ${row.title}`;
  if (row.vendorName?.trim()) return `${row.vendorName.trim()} · ${row.title}`;
  return `Service · ${row.title}`;
}

function workOrderPropertyLabel(row: DemoManagerWorkOrderRow): string | undefined {
  const unit = row.unit?.trim();
  if (unit && unit !== "—") return `${row.propertyName} · ${unit}`;
  return row.propertyName?.trim() || undefined;
}

function buildWorkOrderDescription(row: DemoManagerWorkOrderRow): string {
  return [
    PROPLANE_WORK_ORDER_TYPE_MARKER,
    `Work order: ${row.id}`,
    row.vendorName?.trim() ? `Vendor: ${row.vendorName.trim()}` : null,
    row.residentName?.trim() ? `Resident: ${row.residentName.trim()}` : null,
    row.description?.trim() ? `Details: ${row.description.trim()}` : null,
    PROPLANE_GOOGLE_CALENDAR_MARKER,
  ]
    .filter(Boolean)
    .join("\n");
}

function workOrderVisitEndIso(row: DemoManagerWorkOrderRow): string | null {
  if (!row.scheduledAtIso) return null;
  const start = new Date(row.scheduledAtIso);
  if (Number.isNaN(start.getTime())) return null;
  return new Date(start.getTime() + SERVICE_VISIT_DURATION_MINUTES * 60_000).toISOString();
}

export function workOrderShouldSyncToGoogleCalendar(row: DemoManagerWorkOrderRow): boolean {
  if (row.bucket === "completed" || !row.scheduledAtIso) return false;
  return row.bucket === "scheduled" || Boolean(row.scheduledAtIso);
}

/** Best-effort push, update, or remove a scheduled work order on the manager's Google Calendar. */
export async function syncWorkOrderToGoogleCalendar(
  db: SupabaseClient,
  managerUserId: string,
  row: DemoManagerWorkOrderRow,
): Promise<DemoManagerWorkOrderRow> {
  const managerId = managerUserId.trim();
  if (!managerId) return row;

  const existingEventId = row.googleCalendarEventId?.trim() || null;
  if (!workOrderShouldSyncToGoogleCalendar(row)) {
    if (existingEventId) {
      await deleteGoogleCalendarEvent(db, managerId, existingEventId).catch(() => undefined);
    }
    if (existingEventId) {
      const { googleCalendarEventId: _removed, ...rest } = row;
      return rest;
    }
    return row;
  }

  const endIso = workOrderVisitEndIso(row);
  if (!row.scheduledAtIso || !endIso) return row;

  const googleCalendarEventId = await upsertGoogleCalendarEvent(db, managerId, {
    title: workOrderCalendarTitle(row),
    description: buildWorkOrderDescription(row),
    start: row.scheduledAtIso,
    end: endIso,
    location: workOrderPropertyLabel(row),
    googleCalendarEventId: existingEventId,
  });

  if (!googleCalendarEventId) return row;
  return googleCalendarEventId === existingEventId ? row : { ...row, googleCalendarEventId };
}

export function workOrderGoogleCalendarSyncChanged(
  previous: DemoManagerWorkOrderRow | null | undefined,
  next: DemoManagerWorkOrderRow,
): boolean {
  if (!previous) return workOrderShouldSyncToGoogleCalendar(next);
  return (
    previous.scheduledAtIso !== next.scheduledAtIso ||
    previous.bucket !== next.bucket ||
    previous.title !== next.title ||
    previous.vendorName !== next.vendorName ||
    previous.selfAssigned !== next.selfAssigned ||
    previous.propertyName !== next.propertyName ||
    previous.unit !== next.unit ||
    previous.description !== next.description ||
    previous.googleCalendarEventId !== next.googleCalendarEventId
  );
}

export async function deletePlannedTourByGoogleCalendarEventId(
  db: SupabaseClient,
  googleCalendarEventId: string,
): Promise<boolean> {
  const eventId = googleCalendarEventId.trim();
  if (!eventId) return false;
  const { data: plannedRecord, error: readError } = await db
    .from("portal_schedule_records")
    .select("row_data")
    .eq("id", PLANNED_RECORD_ID)
    .maybeSingle();
  if (readError || !plannedRecord?.row_data) return false;

  const plannedRows = rowsFromPlannedRecord(plannedRecord.row_data);
  const nextRows = plannedRows.filter((row) => String(row.googleCalendarEventId ?? "") !== eventId);
  if (nextRows.length === plannedRows.length) return false;

  const rowData = plannedRecord.row_data as Record<string, unknown>;
  const { error: writeError } = await db.from("portal_schedule_records").upsert(
    {
      id: PLANNED_RECORD_ID,
      manager_user_id: null,
      property_id: (rowData.propertyId as string | null) ?? null,
      record_type: PLANNED_RECORD_ID,
      row_data: { ...rowData, payload: nextRows },
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
  if (writeError) throw new Error(writeError.message);
  return true;
}

/** Bounds the Google round trips one availability save can trigger. */
const MAX_AVAILABILITY_WINDOWS_PER_PUSH = 60;

function googleCalendarAvailabilityEventIds(rowData: unknown): string[] {
  if (!rowData || typeof rowData !== "object" || Array.isArray(rowData)) return [];
  const ids = (rowData as Record<string, unknown>).googleCalendarEventIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0) : [];
}

/** Writes the ids of the currently-pushed availability events back onto the same schedule record. */
async function persistAvailabilityGoogleCalendarEventIds(
  db: SupabaseClient,
  recordId: string,
  eventIds: string[],
): Promise<void> {
  const id = recordId.trim();
  if (!id) return;
  const { data, error } = await db.from("portal_schedule_records").select("row_data").eq("id", id).maybeSingle();
  if (error || !data?.row_data) return;
  const rowData = data.row_data as Record<string, unknown>;
  const { error: writeError } = await db
    .from("portal_schedule_records")
    .update({ row_data: { ...rowData, googleCalendarEventIds: eventIds }, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (writeError) throw new Error(writeError.message);
}

/**
 * Push a manager's painted tour availability to Google as FREE ("Open for
 * tours") events — the WS3 decision "everything the manager enters lands on
 * Google; availability as free, tours as busy". Confirmed tours and work
 * orders keep going through {@link syncPlannedTourToGoogleCalendar} /
 * {@link syncWorkOrderToGoogleCalendar} above, which never set transparency
 * and so stay opaque (busy) — this function is the only caller that opts in
 * to `"transparent"`.
 *
 * Diff-free by design: every window this record previously pushed (tracked as
 * `row_data.googleCalendarEventIds` on the SAME schedule record) is deleted
 * and the current merged set is recreated, rather than reconciled window by
 * window. A save here is a manager action, not a hot loop, so the extra
 * Google round trips are cheap, and delete-then-recreate can never leave a
 * stale half-pushed window behind the way a partial diff could.
 */
export async function syncManagerAvailabilityToGoogleCalendar(
  db: SupabaseClient,
  managerUserId: string,
  input: { recordId: string; rowData: unknown; previousRowData: unknown },
): Promise<void> {
  const managerId = managerUserId.trim();
  if (!managerId) return;
  const connection = await loadGoogleCalendarConnection(db, managerId);
  if (!connection.connected || !connection.syncEnabled) return;

  const staleIds = googleCalendarAvailabilityEventIds(input.previousRowData);
  await Promise.all(staleIds.map((id) => deleteGoogleCalendarEvent(db, managerId, id).catch(() => undefined)));

  const slots = payloadSlots(input.rowData);
  const windows = mergeTourAvailabilitySlotsIntoWindows(slots);
  const boundedWindows = windows.slice(0, MAX_AVAILABILITY_WINDOWS_PER_PUSH);
  if (boundedWindows.length < windows.length) {
    console.warn(
      `[google-calendar] availability push truncated to ${MAX_AVAILABILITY_WINDOWS_PER_PUSH} windows for manager ${managerId.slice(-6)} record ${input.recordId}`,
    );
  }

  const newIds: string[] = [];
  for (const window of boundedWindows) {
    const id = await createGoogleCalendarEvent(db, managerId, {
      title: "Open for tours",
      description: [PROPLANE_GOOGLE_CALENDAR_MARKER, PROPLANE_AVAILABILITY_TYPE_MARKER].join("\n"),
      start: window.start,
      end: window.end,
      transparency: "transparent",
    }).catch(() => null);
    if (id) newIds.push(id);
  }

  await persistAvailabilityGoogleCalendarEventIds(db, input.recordId, newIds).catch(() => undefined);
}

export async function deleteProplaneGoogleCalendarEvent(
  db: SupabaseClient,
  managerUserId: string,
  googleEventId: string,
): Promise<void> {
  const eventId = googleEventId.trim();
  if (!eventId) return;
  await deleteGoogleCalendarEvent(db, managerUserId, eventId);
  await deletePlannedTourByGoogleCalendarEventId(db, eventId).catch(() => undefined);
}
