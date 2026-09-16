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
/** A push that has held the record's lock this long crashed mid-flight; the next push takes over. */
const AVAILABILITY_PUSH_LOCK_STALE_MS = 5 * 60_000;
/** How many times one push re-reads the record after a save landed underneath it. */
const AVAILABILITY_PUSH_MAX_PASSES = 4;
const AVAILABILITY_PUSH_LOCK_ATTEMPTS = 3;

export const AVAILABILITY_PUSH_STATE_RECORD_TYPE = "google_availability_push";

/** Ids a pre-state-row push persisted on the schedule record itself; read once so they still get cleaned up. */
function googleCalendarAvailabilityEventIds(rowData: unknown): string[] {
  if (!rowData || typeof rowData !== "object" || Array.isArray(rowData)) return [];
  const ids = (rowData as Record<string, unknown>).googleCalendarEventIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0) : [];
}

/** `axis_gcal_avail_push_<recordId>` — the server-owned row that tracks what this record has on Google. */
export function availabilityPushStateRecordId(recordId: string): string {
  return `axis_gcal_avail_push_${recordId.trim()}`;
}

type AvailabilityPushState = {
  eventIds: string[];
  lockedAt: string | null;
  /** Set by a push that found the lock held, so the holder runs one more pass before letting go. */
  dirty: boolean;
  sourceUpdatedAt: string | null;
};

function readAvailabilityPushState(rowData: unknown): AvailabilityPushState {
  const row = rowData && typeof rowData === "object" && !Array.isArray(rowData) ? (rowData as Record<string, unknown>) : {};
  const ids = Array.isArray(row.eventIds)
    ? row.eventIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    : [];
  return {
    eventIds: ids,
    lockedAt: typeof row.lockedAt === "string" && row.lockedAt ? row.lockedAt : null,
    dirty: row.dirty === true,
    sourceUpdatedAt: typeof row.sourceUpdatedAt === "string" ? row.sourceUpdatedAt : null,
  };
}

type PushStateRow = { row_data: unknown; updated_at: string | null } | null;

async function loadAvailabilityPushStateRow(db: SupabaseClient, stateId: string): Promise<PushStateRow> {
  const { data, error } = await db
    .from("portal_schedule_records")
    .select("row_data, updated_at")
    .eq("id", stateId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as PushStateRow) ?? null;
}

/**
 * Compare-and-set on the state row's `updated_at`: only the writer that saw
 * the row last wins, so two pushes can never both believe they hold it.
 */
async function casWriteAvailabilityPushState(
  db: SupabaseClient,
  input: { stateId: string; managerUserId: string; expectedUpdatedAt: string | null; state: AvailabilityPushState },
): Promise<string | null> {
  const updatedAt = new Date().toISOString();
  const row = {
    id: input.stateId,
    manager_user_id: input.managerUserId,
    property_id: null,
    record_type: AVAILABILITY_PUSH_STATE_RECORD_TYPE,
    row_data: { ...input.state, recordType: AVAILABILITY_PUSH_STATE_RECORD_TYPE },
    updated_at: updatedAt,
  };
  if (input.expectedUpdatedAt === null) {
    const { error } = await db.from("portal_schedule_records").insert(row);
    return error ? null : updatedAt;
  }
  const { data, error } = await db
    .from("portal_schedule_records")
    .update({ row_data: row.row_data, updated_at: updatedAt })
    .eq("id", input.stateId)
    .eq("updated_at", input.expectedUpdatedAt)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? updatedAt : null;
}

async function loadAvailabilitySource(
  db: SupabaseClient,
  recordId: string,
): Promise<{ rowData: unknown; updatedAt: string | null } | null> {
  const { data, error } = await db
    .from("portal_schedule_records")
    .select("row_data, updated_at")
    .eq("id", recordId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const row = data as { row_data: unknown; updated_at: string | null };
  return { rowData: row.row_data, updatedAt: row.updated_at ?? null };
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
 * Diff-free by design: every window this record previously pushed is deleted
 * and the current merged set is recreated, rather than reconciled window by
 * window. A save here is a manager action, not a hot loop, so the extra
 * Google round trips are cheap, and delete-then-recreate can never leave a
 * stale half-pushed window behind the way a partial diff could.
 *
 * Serialized per record: the pushed ids live on a server-owned state row
 * (`axis_gcal_avail_push_<recordId>`), never on the client-written
 * `row_data` a later save would clobber, and a push must win that row's lock
 * (CAS on `updated_at`) before it touches Google. A push that finds the lock
 * held marks the state dirty and leaves; the holder re-reads the record after
 * every pass and runs again until nothing changed underneath it, so rapid
 * saves collapse into one push of the latest slot set and no event is ever
 * created by one push and forgotten by the next. An id whose Google delete
 * failed stays in the list so the next push retries it instead of leaving an
 * orphaned "Open for tours" block behind.
 */
export async function syncManagerAvailabilityToGoogleCalendar(
  db: SupabaseClient,
  managerUserId: string,
  input: { recordId: string; rowData?: unknown; previousRowData?: unknown },
): Promise<void> {
  const managerId = managerUserId.trim();
  const recordId = input.recordId.trim();
  if (!managerId || !recordId) return;
  const connection = await loadGoogleCalendarConnection(db, managerId);
  if (!connection.connected || !connection.syncEnabled) return;

  const stateId = availabilityPushStateRecordId(recordId);

  let held: { updatedAt: string; state: AvailabilityPushState } | null = null;
  for (let attempt = 0; attempt < AVAILABILITY_PUSH_LOCK_ATTEMPTS && !held; attempt += 1) {
    const stateRow = await loadAvailabilityPushStateRow(db, stateId);
    const current = readAvailabilityPushState(stateRow?.row_data);
    // Legacy: ids persisted on the record itself before the state row existed.
    if (!stateRow) current.eventIds = googleCalendarAvailabilityEventIds(input.previousRowData);
    const lockAgeMs = current.lockedAt ? Date.now() - Date.parse(current.lockedAt) : Number.POSITIVE_INFINITY;
    const lockHeld = Number.isFinite(lockAgeMs) && lockAgeMs < AVAILABILITY_PUSH_LOCK_STALE_MS;
    if (lockHeld) {
      if (current.dirty) return;
      const marked = await casWriteAvailabilityPushState(db, {
        stateId,
        managerUserId: managerId,
        expectedUpdatedAt: stateRow?.updated_at ?? null,
        state: { ...current, dirty: true },
      });
      if (marked) return;
      continue;
    }
    const lockState: AvailabilityPushState = { ...current, lockedAt: new Date().toISOString(), dirty: false };
    const acquiredAt = await casWriteAvailabilityPushState(db, {
      stateId,
      managerUserId: managerId,
      expectedUpdatedAt: stateRow?.updated_at ?? null,
      state: lockState,
    });
    if (acquiredAt) held = { updatedAt: acquiredAt, state: lockState };
  }
  if (!held) return;

  let state = held.state;
  let stateUpdatedAt = held.updatedAt;
  try {
    for (let pass = 0; pass < AVAILABILITY_PUSH_MAX_PASSES; pass += 1) {
      const source = await loadAvailabilitySource(db, recordId);
      const rowData = source ? source.rowData : pass === 0 ? input.rowData : null;
      const sourceUpdatedAt = source?.updatedAt ?? null;

      const retainedIds: string[] = [];
      for (const id of state.eventIds) {
        const deleted = await deleteGoogleCalendarEvent(db, managerId, id).then(() => true, () => false);
        if (!deleted) retainedIds.push(id);
      }

      const windows = mergeTourAvailabilitySlotsIntoWindows(payloadSlots(rowData));
      const boundedWindows = windows.slice(0, MAX_AVAILABILITY_WINDOWS_PER_PUSH);
      if (boundedWindows.length < windows.length) {
        console.warn(
          `[google-calendar] availability push truncated to ${MAX_AVAILABILITY_WINDOWS_PER_PUSH} windows for manager ${managerId.slice(-6)} record ${recordId}`,
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

      state = { eventIds: [...retainedIds, ...newIds], lockedAt: state.lockedAt, dirty: false, sourceUpdatedAt };
      const written = await casWriteAvailabilityPushState(db, {
        stateId,
        managerUserId: managerId,
        expectedUpdatedAt: stateUpdatedAt,
        state,
      });
      if (!written) {
        // A waiter marked the row dirty between our reads: re-read the flag
        // through the row itself and keep the ids we just created either way.
        const fresh = await loadAvailabilityPushStateRow(db, stateId);
        const freshState = readAvailabilityPushState(fresh?.row_data);
        stateUpdatedAt =
          (await casWriteAvailabilityPushState(db, {
            stateId,
            managerUserId: managerId,
            expectedUpdatedAt: fresh?.updated_at ?? null,
            state: { ...state, dirty: false },
          })) ?? stateUpdatedAt;
        if (freshState.dirty) continue;
      } else {
        stateUpdatedAt = written;
      }

      const latest = await loadAvailabilitySource(db, recordId);
      if ((latest?.updatedAt ?? null) === sourceUpdatedAt) break;
    }
  } finally {
    const release = await casWriteAvailabilityPushState(db, {
      stateId,
      managerUserId: managerId,
      expectedUpdatedAt: stateUpdatedAt,
      state: { ...state, lockedAt: null, dirty: false },
    }).catch(() => null);
    if (!release) {
      const fresh = await loadAvailabilityPushStateRow(db, stateId).catch(() => null);
      await casWriteAvailabilityPushState(db, {
        stateId,
        managerUserId: managerId,
        expectedUpdatedAt: fresh?.updated_at ?? null,
        state: { ...state, lockedAt: null, dirty: false },
      }).catch(() => undefined);
    }
  }
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
