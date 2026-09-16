import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import {
  createGoogleCalendarEvent,
  deleteGoogleCalendarEvent,
  updateGoogleCalendarEvent,
} from "@/lib/google-calendar/api.server";
import { loadGoogleCalendarConnection } from "@/lib/google-calendar/settings";
import { mergeTourAvailabilitySlotsIntoWindows, payloadSlots } from "@/lib/tour-slot-math";
import { mutateConfirmedTourSchedule } from "@/lib/tour-schedule-persistence.server";

import {
  PROPLANE_AVAILABILITY_TYPE_MARKER,
  PROPLANE_GOOGLE_CALENDAR_MARKER,
  PROPLANE_TOUR_TYPE_MARKER,
  PROPLANE_WORK_ORDER_TYPE_MARKER,
} from "@/lib/google-calendar/markers";

const PLANNED_RECORD_ID = "axis_admin_planned_events_v1";
const SERVICE_VISIT_DURATION_MINUTES = 60;

type GoogleCalendarUpsertInput = {
  id?: string;
  title: string;
  description: string;
  start: string;
  end: string;
  location?: string;
  googleCalendarEventId?: string | null;
};

type GoogleCalendarUpsertResult = { googleCalendarEventId: string | null; created: boolean };

async function upsertGoogleCalendarEvent(
  db: SupabaseClient,
  managerUserId: string,
  input: GoogleCalendarUpsertInput,
  beforeCreate?: () => Promise<boolean>,
): Promise<GoogleCalendarUpsertResult> {
  const connection = await loadGoogleCalendarConnection(db, managerUserId);
  if (!connection.connected || !connection.syncEnabled) return { googleCalendarEventId: null, created: false };

  const existingId = input.googleCalendarEventId?.trim() || null;
  if (existingId) {
    try {
      return { googleCalendarEventId: await updateGoogleCalendarEvent(db, managerUserId, existingId, input), created: false };
    } catch {
      // Stale or deleted remote event — fall through to create.
    }
  }
  if (beforeCreate && !await beforeCreate()) return { googleCalendarEventId: null, created: false };
  return { googleCalendarEventId: await createGoogleCalendarEvent(db, managerUserId, input), created: true };
}

function deterministicGoogleEventId(managerUserId: string, plannedEventId: string): string {
  // SHA-256 hex uses only 0-9/a-f, a subset of Google's base32hex event-id
  // alphabet, and is stable across a crash between remote insert and local ID
  // persistence.
  return createHash("sha256").update(`${managerUserId}:${plannedEventId}`).digest("hex");
}

async function enqueuePlannedTourGoogleCleanup(
  db: SupabaseClient,
  managerUserId: string,
  plannedEventId: string,
  googleCalendarEventId?: string | null,
): Promise<void> {
  const { error } = await db.rpc("enqueue_prospect_tour_google_calendar_cleanup", {
    p_manager_user_id: managerUserId,
    p_planned_event_id: plannedEventId,
    p_google_calendar_event_id: googleCalendarEventId?.trim() || null,
  });
  if (error) throw new Error(error.message);
}

async function completePlannedTourGoogleCleanup(
  db: SupabaseClient,
  plannedEventId: string,
): Promise<void> {
  const { error } = await db.rpc("complete_prospect_tour_google_calendar_cleanup", {
    p_planned_event_id: plannedEventId,
    p_worker_id: null,
  });
  if (error) throw new Error(error.message);
}

async function beginPlannedTourGoogleCreateIntent(
  db: SupabaseClient,
  managerUserId: string,
  event: { plannedEventId: string; start: string; end: string },
): Promise<string | null> {
  const { data, error } = await db.rpc("begin_prospect_tour_google_calendar_create", {
    p_manager_user_id: managerUserId,
    p_planned_event_id: event.plannedEventId,
    p_expected_start: event.start,
    p_expected_end: event.end,
    p_worker_id: `planned-tour-google-sync:${crypto.randomUUID()}`,
    p_lease_seconds: 120,
  });
  if (error) throw new Error(error.message);
  const result = data as { allowed?: unknown; generation?: unknown } | null;
  return result?.allowed === true && typeof result.generation === "string" ? result.generation : null;
}

async function settlePlannedTourGoogleCreateIntent(
  db: SupabaseClient,
  plannedEventId: string,
  generation: string,
  result: "persisted" | "cleanup_ready" | "unknown",
  error?: unknown,
): Promise<void> {
  const { error: rpcError } = await db.rpc("settle_prospect_tour_google_calendar_create", {
    p_planned_event_id: plannedEventId,
    p_generation: generation,
    p_result: result,
    p_error: error instanceof Error ? error.message : error ? String(error) : null,
  });
  if (rpcError) throw new Error(rpcError.message);
}

async function recordPlannedTourGoogleCleanupFailure(
  db: SupabaseClient,
  managerUserId: string,
  googleCalendarEventId: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : "Google Calendar cleanup failed.";
  await db.from("prospect_tour_google_calendar_cleanup")
    .update({ status: "pending", last_error: message, lease_owner: null, lease_expires_at: null, updated_at: new Date().toISOString() })
    .eq("manager_user_id", managerUserId)
    .eq("google_calendar_event_id", googleCalendarEventId)
    .in("status", ["pending", "running"]);
}

function rowsFromPlannedRecord(rowData: unknown): Record<string, unknown>[] {
  if (!rowData || typeof rowData !== "object") return [];
  const payload = (rowData as { payload?: unknown }).payload;
  return Array.isArray(payload) ? payload.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === "object")) : [];
}

type GoogleIdPersistenceResult =
  | { ok: true }
  | { ok: false; reason: "missing" | "cancelled" | "changed" };

export async function persistPlannedEventGoogleCalendarId(
  db: SupabaseClient,
  plannedEventId: string,
  googleCalendarEventId: string | null,
  expectedEvent?: { start: string; end: string },
): Promise<GoogleIdPersistenceResult> {
  const id = plannedEventId.trim();
  if (!id || !expectedEvent?.start || !expectedEvent.end) return { ok: false, reason: "missing" };
  const { data, error } = await db.rpc("persist_confirmed_tour_google_calendar_id", {
    p_planned_event_id: id,
    p_google_calendar_event_id: googleCalendarEventId?.trim() || null,
    p_expected_start: expectedEvent.start,
    p_expected_end: expectedEvent.end,
  });
  if (error) throw new Error(error.message);
  const result = data as { ok?: unknown; reason?: unknown } | null;
  if (result?.ok === true) return { ok: true };
  const reason = result?.reason;
  return { ok: false, reason: reason === "cancelled" || reason === "changed" ? reason : "missing" };
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
  options?: { ownsGoogleCreateIntent?: boolean },
): Promise<string | null> {
  const syncOnce = async (current: typeof event, allowReconcile: boolean): Promise<string | null> => {
    let createGeneration: string | null = null;
    let upsert: GoogleCalendarUpsertResult;
    try {
      upsert = await upsertGoogleCalendarEvent(db, managerUserId, {
        id: deterministicGoogleEventId(managerUserId, current.plannedEventId),
        title: current.title,
        description: buildTourDescription(current),
        start: current.start,
        end: current.end,
        location: current.propertyTitle,
        googleCalendarEventId: current.googleCalendarEventId,
      }, async () => {
        if (options?.ownsGoogleCreateIntent) return true;
        createGeneration = await beginPlannedTourGoogleCreateIntent(db, managerUserId, current);
        return createGeneration !== null;
      });
    } catch (error) {
      if (createGeneration) {
        await settlePlannedTourGoogleCreateIntent(db, current.plannedEventId, createGeneration, "unknown", error).catch(() => undefined);
      }
      throw error;
    }
    const googleCalendarEventId = upsert.googleCalendarEventId;
    if (!googleCalendarEventId) return null;
    let persisted: GoogleIdPersistenceResult;
    try {
      persisted = await persistPlannedEventGoogleCalendarId(db, current.plannedEventId, googleCalendarEventId, current);
    } catch (error) {
      if (createGeneration) {
        await settlePlannedTourGoogleCreateIntent(db, current.plannedEventId, createGeneration, "unknown", error).catch(() => undefined);
      }
      throw error;
    }
    if (persisted.ok) {
      if (createGeneration) await settlePlannedTourGoogleCreateIntent(db, current.plannedEventId, createGeneration, "persisted");
      return googleCalendarEventId;
    }
    // The remote call returned. Persist a cleanup-ready state before trying a
    // compensating delete, so a crash cannot hide this deterministic remote id.
    if (createGeneration) await settlePlannedTourGoogleCreateIntent(db, current.plannedEventId, createGeneration, "cleanup_ready");

    if (persisted.reason === "changed" && allowReconcile) {
      const { data, error } = await db.from("portal_schedule_records")
        .select("row_data").eq("id", PLANNED_RECORD_ID).maybeSingle();
      if (error) throw new Error(error.message);
      const live = rowsFromPlannedRecord(data?.row_data).find((row) => String(row.id ?? "") === current.plannedEventId);
      if (live && !live.canceledAt && typeof live.start === "string" && typeof live.end === "string") {
        return syncOnce({
          plannedEventId: current.plannedEventId,
          title: String(live.title ?? current.title),
          start: live.start,
          end: live.end,
          propertyTitle: typeof live.propertyTitle === "string" ? live.propertyTitle : undefined,
          attendeeName: typeof live.attendeeName === "string" ? live.attendeeName : undefined,
          attendeeEmail: typeof live.attendeeEmail === "string" ? live.attendeeEmail : undefined,
          attendeePhone: typeof live.attendeePhone === "string" ? live.attendeePhone : undefined,
          notes: typeof live.notes === "string" ? live.notes : undefined,
          instructions: typeof live.instructions === "string" ? live.instructions : undefined,
          googleCalendarEventId: typeof live.googleCalendarEventId === "string" ? live.googleCalendarEventId : googleCalendarEventId,
        }, false);
      }
    }
    // A deleted/cancelled event must not be resurrected. The remote id is
    // deterministic, so compensating this stale write is safe even if the
    // local id was never persisted.
    if (persisted.reason === "changed") {
      // Do not delete here: another sync may already have reconciled the same
      // deterministic remote id to a newer event. Leave recovery pending so it
      // reloads the live event rather than resurrecting this stale snapshot.
      throw new Error("planned_tour_changed_during_google_sync");
    }
    if (persisted.reason === "missing" || persisted.reason === "cancelled") {
      // The schedule mutation's trigger writes the same obligation for a
      // committed cancel/delete. This explicit upsert also covers a process
      // crash between remote insert and that mutation becoming observable.
      await enqueuePlannedTourGoogleCleanup(db, managerUserId, current.plannedEventId, googleCalendarEventId);
      try {
        await deleteGoogleCalendarEvent(db, managerUserId, googleCalendarEventId);
        await completePlannedTourGoogleCleanup(db, current.plannedEventId);
      } catch (error) {
        await recordPlannedTourGoogleCleanupFailure(db, managerUserId, googleCalendarEventId, error);
        throw error;
      }
    }
    return null;
  };
  return syncOnce(event, true);
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
      const rest = { ...row };
      delete rest.googleCalendarEventId;
      return rest;
    }
    return row;
  }

  const endIso = workOrderVisitEndIso(row);
  if (!row.scheduledAtIso || !endIso) return row;

  const { googleCalendarEventId } = await upsertGoogleCalendarEvent(db, managerId, {
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
  if (!plannedRows.some((row) => String(row.googleCalendarEventId ?? "") === eventId)) return false;

  const removed = plannedRows.find((row) => String(row.googleCalendarEventId ?? "") === eventId);
  if (!removed) return false;
  const persisted = await mutateConfirmedTourSchedule(db as never, { operation: "cancel", event: removed });
  if (!persisted.ok) throw new Error(persisted.reason);
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
  const { data: plannedRecord } = await db.from("portal_schedule_records")
    .select("row_data").eq("id", PLANNED_RECORD_ID).maybeSingle();
  const plannedEventId = String(rowsFromPlannedRecord(plannedRecord?.row_data)
    .find((row) => String(row.googleCalendarEventId ?? "") === eventId)?.id ?? "");
  await deletePlannedTourByGoogleCalendarEventId(db, eventId).catch(() => undefined);
  // A schedule cancel/delete creates a durable cleanup row. Completing it
  // here makes an already-successful direct delete idempotent for recovery.
  if (plannedEventId) await completePlannedTourGoogleCleanup(db, plannedEventId);
}
