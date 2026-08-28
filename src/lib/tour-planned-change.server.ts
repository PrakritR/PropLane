/**
 * Cancel or reschedule a tour that is ALREADY CONFIRMED.
 *
 * Confirming a tour used to be a one-way door: the detail modal offered a
 * confirmed tour exactly two controls, `Close` and `Delete event`, and delete
 * fired with no confirmation, removed the tour instantly, and sent the guest
 * nothing — after PropLane had already emailed them "Your PropLane tour is
 * confirmed". A guest could travel to a property for a tour that no longer
 * existed and nobody would have told them.
 *
 * This module is the server half of the two actions that replace that. It sits
 * beside `tour-inquiry-confirm.server.ts` and shares its record ids and payload
 * shape deliberately — a confirmed tour is a row in the SAME
 * `axis_admin_planned_events_v1` payload, so the booking guard, the public
 * availability grid and these two actions all read one source.
 */
import { PRODUCTION_APP_ORIGIN } from "@/lib/app-url";
import {
  GOOGLE_CALENDAR_WRITE_OPERATION_TIMEOUT_MS,
  isGoogleCalendarNotLinkedError,
} from "@/lib/google-calendar/api.server";
import {
  deleteProplaneGoogleCalendarEvent,
  syncPlannedTourToGoogleCalendar,
} from "@/lib/google-calendar/sync.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import {
  notifyTenantTourCanceled,
  notifyTenantTourRescheduled,
} from "@/lib/tour-notification-delivery.server";
import { formatRangeLabel, PLANNED_RECORD_ID, rowsFromRecord } from "@/lib/tour-inquiry-confirm.server";
import { isActivePlannedTourEvent } from "@/lib/tour-slot-math";

type Db = ReturnType<typeof createSupabaseServiceRoleClient>;

/** A reschedule may not stretch a tour past this; mirrors the confirm path. */
const MAX_EVENT_DURATION_MS = 480 * 60_000;

function textField(row: Record<string, unknown> | null | undefined, key: string): string {
  const value = row?.[key];
  return typeof value === "string" ? value.trim() : "";
}

/** The guest-facing inquiry fields a planned tour carries; enough to notify. */
function inquiryFromPlannedEvent(event: Record<string, unknown>): Record<string, unknown> {
  return {
    id: textField(event, "sourceInquiryId") || textField(event, "id"),
    name: textField(event, "attendeeName"),
    email: textField(event, "attendeeEmail"),
    phone: textField(event, "attendeePhone"),
    propertyId: textField(event, "propertyId"),
    propertyTitle: textField(event, "propertyTitle"),
    roomLabel: textField(event, "roomLabel"),
    notes: textField(event, "notes"),
    adminLabel: textField(event, "adminLabel"),
    smsConsent: event.smsConsent,
  };
}

/**
 * Outcome of the manager's linked-Google-Calendar side of the change.
 *
 * It is reported, never thrown: the PropLane-side change already succeeded and
 * the guest has already been told, so a Google failure must not turn a real
 * cancel into an error. But it cannot be swallowed either — public tour
 * availability now subtracts Google busy time, so a surviving ghost event
 * permanently blocks the half hour the manager just freed.
 */
export type PlannedTourCalendarSync = { ok: boolean; skipped?: boolean; error?: string };

/**
 * Whole-operation ceiling on the Google side of a cancel or reschedule.
 *
 * The shared ladder's WRITE budget, unmodified — already sized above the bounded
 * worst case of the calls below it (a token hop plus one API call) and tight
 * enough to leave the rest of the handler real headroom under the smallest
 * default platform function limit. Padding it here would eat that headroom, and
 * the platform kill it invites is the exact outcome this race exists to prevent:
 * the client reporting "could not reach the server" for a change that already
 * committed and a guest who was already emailed.
 *
 * Known gap, deliberately not widened here: the guest notification that runs
 * BEFORE this (Resend email, consent-gated SMS) is unbounded. That path is
 * shared with `confirmTourInquiry`, so bounding it belongs in its own change.
 */
const CALENDAR_SYNC_BUDGET_MS = GOOGLE_CALENDAR_WRITE_OPERATION_TIMEOUT_MS;

/**
 * Run the Google side of a change and CLASSIFY the outcome, never throw it.
 *
 * "No working calendar link" is reported as SKIPPED, not as a failure: the
 * delete path throws for that state while the upsert path quietly returns null,
 * and without this the two would disagree — a manager who linked Google once and
 * later disconnected would be warned "your Google Calendar did not update" on
 * every cancel and told nothing on reschedule for the identical state.
 */
async function runCalendarSync(run: () => Promise<unknown>): Promise<PlannedTourCalendarSync> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<PlannedTourCalendarSync>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, error: "Google Calendar did not respond in time." }),
      CALENDAR_SYNC_BUDGET_MS,
    );
  });
  try {
    return await Promise.race([
      run().then(
        () => ({ ok: true }),
        (e: unknown) => {
          if (isGoogleCalendarNotLinkedError(e)) return { ok: true, skipped: true };
          return { ok: false, error: e instanceof Error ? e.message : "Google Calendar update failed." };
        },
      ),
      deadline,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type PlannedTourChangeResult =
  | {
      ok: true;
      message: string;
      guestNotification: { ok: boolean; skipped?: boolean; error?: string } | null;
      calendarSync: PlannedTourCalendarSync;
    }
  | { ok: false; status: number; error: string };

type LoadedTour = {
  plannedRows: Record<string, unknown>[];
  event: Record<string, unknown>;
  index: number;
};

async function loadOwnedPlannedTour(
  db: Db,
  input: { plannedEventId: string; actorUserId: string; isAdmin?: boolean },
): Promise<LoadedTour | { ok: false; status: number; error: string }> {
  const id = input.plannedEventId.trim();
  if (!id) return { ok: false, status: 400, error: "id required" };

  const { data, error } = await db
    .from("portal_schedule_records")
    .select("row_data")
    .eq("id", PLANNED_RECORD_ID)
    .maybeSingle();
  // A failed read is not an absent tour: answering 404 here would tell the
  // manager the tour is already gone while it is still on the calendar.
  if (error) return { ok: false, status: 500, error: error.message };

  const plannedRows = rowsFromRecord(data?.row_data);
  const index = plannedRows.findIndex((row) => textField(row, "id") === id);
  if (index === -1) return { ok: false, status: 404, error: "Tour not found." };

  const event = plannedRows[index]!;
  if (textField(event, "kind") !== "tour") {
    return { ok: false, status: 400, error: "That calendar event is not a tour." };
  }
  const managerUserId = textField(event, "managerUserId");
  if (!managerUserId || (!input.isAdmin && managerUserId !== input.actorUserId)) {
    return { ok: false, status: 403, error: "Unauthorized." };
  }
  return { plannedRows, event, index };
}

async function writePlannedRows(db: Db, rows: Record<string, unknown>[]): Promise<string | null> {
  const { error } = await db.from("portal_schedule_records").upsert(
    [
      {
        id: PLANNED_RECORD_ID,
        manager_user_id: null,
        property_id: null,
        record_type: PLANNED_RECORD_ID,
        row_data: {
          id: PLANNED_RECORD_ID,
          recordType: PLANNED_RECORD_ID,
          managerUserId: null,
          propertyId: null,
          payload: rows,
        },
        updated_at: new Date().toISOString(),
      },
    ],
    { onConflict: "id" },
  );
  return error?.message ?? null;
}

/** True when another confirmed tour of the same manager occupies [start, end). */
function windowTakenByAnotherTour(
  plannedRows: Record<string, unknown>[],
  input: { managerUserId: string; start: string; end: string; exceptEventId: string },
): boolean {
  const startMs = Date.parse(input.start);
  const endMs = Date.parse(input.end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return false;
  return plannedRows.some((row) => {
    if (textField(row, "id") === input.exceptEventId) return false;
    if (textField(row, "kind") !== "tour") return false;
    if (!isActivePlannedTourEvent(row)) return false;
    if (textField(row, "managerUserId") !== input.managerUserId) return false;
    const rowStart = Date.parse(textField(row, "start"));
    const rowEnd = Date.parse(textField(row, "end"));
    if (![rowStart, rowEnd].every(Number.isFinite)) return false;
    return startMs < rowEnd && rowStart < endMs;
  });
}

/**
 * Cancel a confirmed tour and TELL THE GUEST.
 *
 * `notifyGuest` defaults to true at every caller; passing false is the manager
 * explicitly choosing silence (a tour they booked for themselves, a guest they
 * already phoned), not the default path.
 */
export async function cancelPlannedTour(
  db: Db,
  opts: {
    plannedEventId: string;
    actorUserId: string;
    isAdmin?: boolean;
    reason?: string | null;
    notifyGuest: boolean;
    notificationSubject?: string;
    notificationBody?: string;
    req?: Request;
  },
): Promise<PlannedTourChangeResult> {
  const loaded = await loadOwnedPlannedTour(db, opts);
  if ("ok" in loaded) return loaded;
  const { plannedRows, event } = loaded;

  const start = textField(event, "start");
  const end = textField(event, "end");
  const managerUserId = textField(event, "managerUserId");

  const writeError = await writePlannedRows(
    db,
    plannedRows.map((row) =>
      textField(row, "id") === opts.plannedEventId.trim()
        ? { ...row, canceledAt: new Date().toISOString() }
        : row,
    ),
  );
  if (writeError) return { ok: false, status: 500, error: writeError };

  // Only after the tour is really gone: a guest told "cancelled" for a tour
  // still on the calendar is worse than one told nothing.
  let guestNotification: { ok: boolean; skipped?: boolean; error?: string } | null = null;
  if (opts.notifyGuest) {
    const notifyReq = opts.req ?? new Request(PRODUCTION_APP_ORIGIN);
    guestNotification = await notifyTenantTourCanceled(
      db,
      notifyReq,
      inquiryFromPlannedEvent(event),
      { start, end, adminLabel: textField(event, "adminLabel") || undefined },
      opts.reason,
      {
        subject: opts.notificationSubject,
        body: opts.notificationBody,
      },
    );
  }

  // Awaited, not fire-and-forget: a serverless runtime can freeze the instance
  // the moment the response is returned, which would strand the Google event as
  // busy time blocking the slot this cancel just freed.
  const googleEventId = textField(event, "googleCalendarEventId");
  let calendarSync: PlannedTourCalendarSync = { ok: true, skipped: true };
  if (googleEventId && managerUserId) {
    calendarSync = await runCalendarSync(() =>
      deleteProplaneGoogleCalendarEvent(db, managerUserId, googleEventId),
    );
  }

  return { ok: true, message: formatRangeLabel(start, end), guestNotification, calendarSync };
}

/** Move a confirmed tour to a new window and tell the guest the new time. */
export async function reschedulePlannedTour(
  db: Db,
  opts: {
    plannedEventId: string;
    actorUserId: string;
    isAdmin?: boolean;
    start: string;
    end: string;
    reason?: string | null;
    instructions?: string | null;
    notifyGuest: boolean;
    notificationSubject?: string;
    notificationBody?: string;
    req?: Request;
  },
): Promise<PlannedTourChangeResult> {
  const start = opts.start.trim();
  const end = opts.end.trim();
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return { ok: false, status: 400, error: "Pick a valid new start and end time." };
  }
  if (endMs - startMs > MAX_EVENT_DURATION_MS) {
    return { ok: false, status: 400, error: "A tour cannot run longer than 8 hours." };
  }

  const loaded = await loadOwnedPlannedTour(db, opts);
  if ("ok" in loaded) return loaded;
  const { plannedRows, event, index } = loaded;

  const managerUserId = textField(event, "managerUserId");
  const previous = { start: textField(event, "start"), end: textField(event, "end") };
  if (previous.start === start && previous.end === end) {
    return { ok: false, status: 400, error: "That is the time this tour is already booked for." };
  }
  if (
    windowTakenByAnotherTour(plannedRows, {
      managerUserId,
      start,
      end,
      exceptEventId: opts.plannedEventId.trim(),
    })
  ) {
    return { ok: false, status: 409, error: "Another confirmed tour already occupies that time." };
  }

  const instructions = opts.instructions?.trim() ?? "";
  const moved: Record<string, unknown> = {
    ...event,
    start,
    end,
    // The old slotKey named the old half hour. Keeping it would leave the new
    // window bookable and the old one blocked in the public grid — the exact
    // double-booking shape this sweep is closing. Nothing else re-derives it,
    // so drop it and let the time range speak.
    slotKey: undefined,
    ...(instructions ? { instructions } : {}),
  };
  const nextRows = [...plannedRows];
  nextRows[index] = moved;

  const writeError = await writePlannedRows(db, nextRows);
  if (writeError) return { ok: false, status: 500, error: writeError };

  let guestNotification: { ok: boolean; skipped?: boolean; error?: string } | null = null;
  if (opts.notifyGuest) {
    const notifyReq = opts.req ?? new Request(PRODUCTION_APP_ORIGIN);
    guestNotification = await notifyTenantTourRescheduled(db, notifyReq, inquiryFromPlannedEvent(event), {
      window: { start, end, adminLabel: textField(event, "adminLabel") || undefined },
      previousWindow: previous,
      reason: opts.reason,
      instructions: instructions || textField(event, "instructions") || null,
      subject: opts.notificationSubject,
      body: opts.notificationBody,
    });
  }

  // Awaited for the same reason as the cancel path: the move has to land before
  // the response, or the old window stays busy on the manager's calendar and
  // keeps blocking a slot the tour no longer occupies.
  let calendarSync: PlannedTourCalendarSync = { ok: true, skipped: true };
  if (managerUserId) {
    calendarSync = await runCalendarSync(() =>
      syncPlannedTourToGoogleCalendar(db, managerUserId, {
        plannedEventId: String(moved.id),
        title: textField(moved, "title") || "Tour",
        start,
        end,
        propertyTitle: textField(moved, "propertyTitle") || undefined,
        attendeeName: textField(moved, "attendeeName") || undefined,
        attendeeEmail: textField(moved, "attendeeEmail") || undefined,
        attendeePhone: textField(moved, "attendeePhone") || undefined,
        notes: textField(moved, "notes") || undefined,
        instructions: textField(moved, "instructions") || undefined,
        // Carry the existing Google event id so a reschedule MOVES the manager's
        // calendar entry; without it the old time stays on their calendar as a
        // ghost tour and keeps blocking the slot it no longer occupies.
        googleCalendarEventId: textField(moved, "googleCalendarEventId") || null,
      }),
    );
  }

  return { ok: true, message: formatRangeLabel(start, end), guestNotification, calendarSync };
}
