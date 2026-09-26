import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  isGoogleCalendarNotLinkedError,
  listGoogleCalendarWriteEventsForSync,
  type GoogleCalendarSyncPage,
} from "@/lib/google-calendar/api.server";
import { PROPLANE_GOOGLE_CALENDAR_MARKER } from "@/lib/google-calendar/markers";
import { loadGoogleCalendarConnection, saveGoogleCalendarConnection } from "@/lib/google-calendar/settings";
import { mutateConfirmedTourSchedule } from "@/lib/tour-schedule-persistence.server";
import {
  deletePlannedTourByGoogleCalendarEventId,
  SERVICE_VISIT_DURATION_MINUTES,
  syncPlannedTourToGoogleCalendar,
  syncWorkOrderToGoogleCalendar,
} from "@/lib/google-calendar/sync.server";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";

/**
 * "Google edited or deleted a PropLane-authored event" — the two-way half
 * that never existed before: `pull.server.ts` mirrors the user's OTHER
 * calendar events into PropLane for busy-time, but a PropLane-owned event
 * (a confirmed tour, a service visit) that the user themselves changed on
 * Google was previously just silently skipped (see
 * `isProplaneOriginatedEvent` in `pull.server.ts`) — the PropLane-side record
 * never learned about it, so the two copies quietly drifted apart.
 *
 * This module closes that gap for events living on the DEDICATED write
 * calendar (`connection.writeCalendarId`, see `proplane-calendar.server.ts`):
 * it walks that calendar's own incremental sync feed, diffs every
 * PropLane-owned event against the PropLane-side record it came from, and
 * records a `google_calendar_pending_changes` row rather than ever silently
 * rescheduling or cancelling anything. A manager or vendor then explicitly
 * accepts (apply Google's version) or dismisses (keep PropLane's version,
 * overwrite Google) each row from the Calendar page.
 *
 * Deliberately scoped to the write calendar only: a connection that predates
 * `calendar.app.created` (no `writeCalendarId` yet) has no dedicated
 * calendar to walk, so it gets no reconciliation until it reconnects. That
 * connection's PropLane events still live on the primary calendar mixed with
 * personal ones, and diffing THAT indiscriminately would misclassify a
 * manager's own personal edits to their primary calendar as "PropLane
 * conflicts" — out of scope here, and safer to leave alone than guess at.
 */

export type GoogleCalendarPendingChangeOwnerKind = "manager" | "vendor";
export type GoogleCalendarPendingChangeRecordKind = "tour" | "work_order";
export type GoogleCalendarPendingChangeType = "time_changed" | "deleted";

export type GoogleCalendarPendingChange = {
  id: string;
  ownerUserId: string;
  ownerKind: GoogleCalendarPendingChangeOwnerKind;
  recordKind: GoogleCalendarPendingChangeRecordKind;
  recordId: string;
  googleCalendarEventId: string;
  changeType: GoogleCalendarPendingChangeType;
  summary: string | null;
  previousStart: string | null;
  previousEnd: string | null;
  proposedStart: string | null;
  proposedEnd: string | null;
  status: "pending" | "accepted" | "dismissed";
  createdAt: string;
  updatedAt: string;
};

type PendingChangeDbRow = {
  id: string;
  owner_user_id: string;
  owner_kind: string;
  record_kind: string;
  record_id: string;
  google_calendar_event_id: string;
  change_type: string;
  summary: string | null;
  previous_start: string | null;
  previous_end: string | null;
  proposed_start: string | null;
  proposed_end: string | null;
  status: string;
  created_at: string;
  updated_at: string;
};

function fromDbRow(row: PendingChangeDbRow): GoogleCalendarPendingChange {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    ownerKind: row.owner_kind === "vendor" ? "vendor" : "manager",
    recordKind: row.record_kind === "work_order" ? "work_order" : "tour",
    recordId: row.record_id,
    googleCalendarEventId: row.google_calendar_event_id,
    changeType: row.change_type === "deleted" ? "deleted" : "time_changed",
    summary: row.summary,
    previousStart: row.previous_start,
    previousEnd: row.previous_end,
    proposedStart: row.proposed_start,
    proposedEnd: row.proposed_end,
    status: row.status === "accepted" ? "accepted" : row.status === "dismissed" ? "dismissed" : "pending",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function pendingChangeId(ownerUserId: string, googleEventId: string): string {
  return `axis_gcal_pending_${ownerUserId}_${googleEventId}`;
}

function isProplaneOriginatedEvent(description: string | undefined): boolean {
  return (description ?? "").toLowerCase().includes(PROPLANE_GOOGLE_CALENDAR_MARKER.toLowerCase());
}

const PLANNED_RECORD_ID = "axis_admin_planned_events_v1";

function rowsFromPlannedRecord(rowData: unknown): Record<string, unknown>[] {
  if (!rowData || typeof rowData !== "object") return [];
  const payload = (rowData as { payload?: unknown }).payload;
  return Array.isArray(payload) ? payload.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === "object")) : [];
}

type OwnedRecordLookup =
  | {
      kind: "tour";
      recordId: string;
      event: Record<string, unknown>;
      expectedStart: string | null;
      expectedEnd: string | null;
      cancelled: boolean;
      summary: string | null;
    }
  | {
      kind: "work_order";
      recordId: string;
      row: DemoManagerWorkOrderRow;
      expectedStart: string | null;
      expectedEnd: string | null;
      cancelled: boolean;
      summary: string | null;
    }
  | null;

/** Finds the PropLane-side record (tour or work order) that owns this Google event, if any. */
async function findOwnedRecord(db: SupabaseClient, googleEventId: string): Promise<OwnedRecordLookup> {
  const { data: plannedRecord } = await db
    .from("portal_schedule_records")
    .select("row_data")
    .eq("id", PLANNED_RECORD_ID)
    .maybeSingle();
  const tourRow = rowsFromPlannedRecord(plannedRecord?.row_data).find(
    (row) => String(row.googleCalendarEventId ?? "") === googleEventId,
  );
  if (tourRow) {
    const start = typeof tourRow.start === "string" ? tourRow.start : null;
    const end = typeof tourRow.end === "string" ? tourRow.end : null;
    const cancelled = typeof tourRow.canceledAt === "string" && Boolean(tourRow.canceledAt);
    return {
      kind: "tour",
      recordId: String(tourRow.id ?? ""),
      event: tourRow,
      expectedStart: start,
      expectedEnd: end,
      cancelled,
      summary: typeof tourRow.title === "string" ? tourRow.title : "Tour",
    };
  }

  const { data: workOrderRows } = await db
    .from("portal_work_order_records")
    .select("id, row_data")
    .eq("row_data->>googleCalendarEventId", googleEventId)
    .limit(1);
  const workOrderRow = (workOrderRows ?? [])[0] as { id: string; row_data: unknown } | undefined;
  if (workOrderRow) {
    const row = workOrderRow.row_data as DemoManagerWorkOrderRow;
    const start = typeof row.scheduledAtIso === "string" ? row.scheduledAtIso : null;
    const end = start ? new Date(new Date(start).getTime() + SERVICE_VISIT_DURATION_MINUTES * 60_000).toISOString() : null;
    return {
      kind: "work_order",
      recordId: workOrderRow.id,
      row,
      expectedStart: start,
      expectedEnd: end,
      // No "cancelled" bucket exists (`ManagerWorkOrderBucket` is
      // `"open" | "scheduled" | "completed"`); a work order this reconciler
      // should no longer protect is one already unscheduled back to "open"
      // (see `acceptChange`'s deletion branch) or completed.
      cancelled: row.bucket === "completed" || (row.bucket === "open" && !row.scheduledAtIso),
      summary: typeof row.title === "string" ? row.title : "Service visit",
    };
  }

  return null;
}

export type PullProplaneCalendarPendingChangesResult = {
  ok: boolean;
  pending: number;
  resolvedAutomatically: number;
  reason?: "not_connected" | "no_write_calendar" | "mirror_write_failed";
};

/**
 * Walks the dedicated write calendar's incremental sync feed and records (or
 * clears) `google_calendar_pending_changes` rows for every PropLane-owned
 * event Google reports as edited or deleted.
 */
export async function pullProplaneCalendarPendingChanges(
  db: SupabaseClient,
  ownerUserId: string,
  ownerKind: GoogleCalendarPendingChangeOwnerKind,
): Promise<PullProplaneCalendarPendingChangesResult> {
  const uid = ownerUserId.trim();
  if (!uid) return { ok: false, pending: 0, resolvedAutomatically: 0, reason: "not_connected" };

  const connection = await loadGoogleCalendarConnection(db, uid);
  if (!connection.connected || !connection.syncEnabled) {
    return { ok: false, pending: 0, resolvedAutomatically: 0, reason: "not_connected" };
  }

  let page;
  try {
    page = await listGoogleCalendarWriteEventsForSync(db, uid, connection.proplaneSyncToken ?? null);
  } catch (e) {
    if (isGoogleCalendarNotLinkedError(e)) {
      return { ok: false, pending: 0, resolvedAutomatically: 0, reason: "not_connected" };
    }
    throw e;
  }
  if ("noWriteCalendar" in page && page.noWriteCalendar) {
    return { ok: true, pending: 0, resolvedAutomatically: 0, reason: "no_write_calendar" };
  }
  // Past the check above, this connection has a write calendar — a retry
  // with a fresh (null) token cannot flip that back, so it is safe to treat
  // every subsequent result as the full sync page shape.
  let syncPage = page as GoogleCalendarSyncPage;
  if (syncPage.syncTokenInvalid) {
    await saveGoogleCalendarConnection(db, uid, { proplaneSyncToken: null }).catch(() => undefined);
    syncPage = (await listGoogleCalendarWriteEventsForSync(db, uid, null)) as GoogleCalendarSyncPage;
  }

  let writeFailures = 0;
  let pending = 0;
  let resolvedAutomatically = 0;

  for (const event of syncPage.events) {
    if (event.status !== "cancelled" && !isProplaneOriginatedEvent(event.description)) {
      // Not something PropLane created (a stray manual event on the
      // dedicated calendar) — nothing to reconcile it against.
      continue;
    }
    const owned = await findOwnedRecord(db, event.id);
    if (!owned || owned.cancelled) {
      // Either nothing on file for this id, or the PropLane side already
      // considers it gone — no PropLane record left to protect.
      continue;
    }

    const id = pendingChangeId(uid, event.id);
    if (event.status === "cancelled") {
      const { error } = await db.from("google_calendar_pending_changes").upsert(
        {
          id,
          owner_user_id: uid,
          owner_kind: ownerKind,
          record_kind: owned.kind,
          record_id: owned.recordId,
          google_calendar_event_id: event.id,
          change_type: "deleted",
          summary: owned.summary,
          previous_start: owned.expectedStart,
          previous_end: owned.expectedEnd,
          proposed_start: null,
          proposed_end: null,
          status: "pending",
          updated_at: new Date().toISOString(),
        },
        { onConflict: "id" },
      );
      if (error) writeFailures += 1;
      else pending += 1;
      continue;
    }

    const matches =
      event.start === owned.expectedStart && event.end === owned.expectedEnd;
    if (matches) {
      const { error, count } = await db
        .from("google_calendar_pending_changes")
        .delete({ count: "exact" })
        .eq("id", id)
        .eq("status", "pending");
      if (!error && (count ?? 0) > 0) resolvedAutomatically += 1;
      continue;
    }

    const { error } = await db.from("google_calendar_pending_changes").upsert(
      {
        id,
        owner_user_id: uid,
        owner_kind: ownerKind,
        record_kind: owned.kind,
        record_id: owned.recordId,
        google_calendar_event_id: event.id,
        change_type: "time_changed",
        summary: owned.summary,
        previous_start: owned.expectedStart,
        previous_end: owned.expectedEnd,
        proposed_start: event.start ?? null,
        proposed_end: event.end ?? null,
        status: "pending",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    );
    if (error) writeFailures += 1;
    else pending += 1;
  }

  if (syncPage.nextSyncToken && !syncPage.truncated && writeFailures === 0) {
    await saveGoogleCalendarConnection(db, uid, { proplaneSyncToken: syncPage.nextSyncToken }).catch(() => undefined);
  }

  return {
    ok: writeFailures === 0,
    pending,
    resolvedAutomatically,
    ...(writeFailures > 0 ? { reason: "mirror_write_failed" as const } : {}),
  };
}

export async function listPendingGoogleCalendarChanges(
  db: SupabaseClient,
  ownerUserId: string,
): Promise<GoogleCalendarPendingChange[]> {
  const { data, error } = await db
    .from("google_calendar_pending_changes")
    .select("*")
    .eq("owner_user_id", ownerUserId)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error || !Array.isArray(data)) return [];
  return (data as PendingChangeDbRow[]).map(fromDbRow);
}

export type ResolvePendingGoogleCalendarChangeResult = { ok: true } | { ok: false; reason: string };

/**
 * `"accept"` applies Google's version to the PropLane-side record (a
 * time change goes through the SAME guarded reschedule boundary a manual
 * reschedule uses, `mutateConfirmedTourSchedule`'s `"replace"` operation, so
 * it gets the identical notification-eligible handling; a deletion cancels
 * the PropLane record through the existing cancel path).
 * `"dismiss"` keeps PropLane's version and re-pushes it to Google, overwriting
 * whatever the user changed there.
 * Either way the pending row is marked resolved, never deleted, so the
 * decision stays auditable.
 */
export async function resolvePendingGoogleCalendarChange(
  db: SupabaseClient,
  ownerUserId: string,
  pendingChangeId_: string,
  action: "accept" | "dismiss",
): Promise<ResolvePendingGoogleCalendarChangeResult> {
  const { data, error } = await db
    .from("google_calendar_pending_changes")
    .select("*")
    .eq("id", pendingChangeId_)
    .eq("owner_user_id", ownerUserId)
    .eq("status", "pending")
    .maybeSingle();
  if (error) return { ok: false, reason: error.message };
  if (!data) return { ok: false, reason: "not_found" };
  const change = fromDbRow(data as PendingChangeDbRow);

  const result = action === "accept" ? await acceptChange(db, change) : await dismissChange(db, ownerUserId, change);
  if (!result.ok) return result;

  const { error: updateError } = await db
    .from("google_calendar_pending_changes")
    .update({ status: action === "accept" ? "accepted" : "dismissed", updated_at: new Date().toISOString() })
    .eq("id", change.id);
  if (updateError) return { ok: false, reason: updateError.message };
  return { ok: true };
}

async function acceptChange(
  db: SupabaseClient,
  change: GoogleCalendarPendingChange,
): Promise<ResolvePendingGoogleCalendarChangeResult> {
  if (change.changeType === "deleted") {
    try {
      await deletePlannedTourByGoogleCalendarEventId(db, change.googleCalendarEventId);
    } catch {
      /* fall through — a work order deletion is handled below */
    }
    if (change.recordKind === "work_order") {
      // No "cancelled" bucket exists (`ManagerWorkOrderBucket` is
      // `"open" | "scheduled" | "completed"`) — a deleted visit goes back to
      // unscheduled `"open"`, the same shape
      // `resident-work-order-lifecycle.server.ts` already uses to clear a
      // visit's schedule, and `googleCalendarEventId` is dropped since the
      // remote event is already gone.
      const current = await currentWorkOrderRowData(db, change.recordId);
      const nextRow = { ...current, bucket: "open", scheduledAtIso: undefined, googleCalendarEventId: undefined };
      const { error } = await db.from("portal_work_order_records").update({ row_data: nextRow }).eq("id", change.recordId);
      if (error) return { ok: false, reason: error.message };
    }
    return { ok: true };
  }

  if (!change.proposedStart || !change.proposedEnd) return { ok: false, reason: "missing_proposed_window" };

  if (change.recordKind === "tour") {
    const owned = await findOwnedRecord(db, change.googleCalendarEventId);
    if (!owned || owned.kind !== "tour") return { ok: false, reason: "stale_event" };
    const generation =
      typeof owned.event.rescheduleNotificationGeneration === "string"
        ? owned.event.rescheduleNotificationGeneration
        : null;
    const updatedEvent = { ...owned.event, start: change.proposedStart, end: change.proposedEnd };
    const mutated = await mutateConfirmedTourSchedule(db as never, {
      operation: "replace",
      event: updatedEvent,
      expected: { start: change.previousStart ?? owned.expectedStart ?? "", end: change.previousEnd ?? owned.expectedEnd ?? "", generation },
    });
    if (!mutated.ok) return { ok: false, reason: mutated.reason };
    return { ok: true };
  }

  // Work order: PropLane's `scheduledAtIso` becomes Google's proposed start;
  // work orders carry no separate stored end (it is always derived), so only
  // the start needs writing back.
  const rowData = await currentWorkOrderRowData(db, change.recordId);
  const nextRow = { ...rowData, scheduledAtIso: change.proposedStart } as DemoManagerWorkOrderRow;
  const { error } = await db.from("portal_work_order_records").update({ row_data: nextRow }).eq("id", change.recordId);
  if (error) return { ok: false, reason: error.message };
  return { ok: true };
}

async function dismissChange(
  db: SupabaseClient,
  ownerUserId: string,
  change: GoogleCalendarPendingChange,
): Promise<ResolvePendingGoogleCalendarChangeResult> {
  if (change.recordKind === "tour") {
    const owned = await findOwnedRecord(db, change.googleCalendarEventId);
    if (!owned || owned.kind !== "tour") return { ok: false, reason: "stale_event" };
    try {
      await syncPlannedTourToGoogleCalendar(db, ownerUserId, {
        plannedEventId: owned.recordId,
        title: typeof owned.event.title === "string" ? owned.event.title : "Tour",
        start: owned.expectedStart ?? change.previousStart ?? "",
        end: owned.expectedEnd ?? change.previousEnd ?? "",
        googleCalendarEventId: change.googleCalendarEventId,
      });
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "sync_failed" };
    }
    return { ok: true };
  }

  const rowData = await currentWorkOrderRowData(db, change.recordId);
  try {
    await syncWorkOrderToGoogleCalendar(db, ownerUserId, rowData as DemoManagerWorkOrderRow);
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "sync_failed" };
  }
  return { ok: true };
}

async function currentWorkOrderRowData(db: SupabaseClient, id: string): Promise<Record<string, unknown>> {
  const { data } = await db.from("portal_work_order_records").select("row_data").eq("id", id).maybeSingle();
  return (data?.row_data && typeof data.row_data === "object" ? (data.row_data as Record<string, unknown>) : {});
}
