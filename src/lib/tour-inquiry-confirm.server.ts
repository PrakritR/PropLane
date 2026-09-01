/**
 * The reusable core of confirming a pending tour inquiry into a booked event.
 *
 * This is the single implementation behind BOTH the manual "Accept tour" route
 * (`/api/portal-tour-inquiries/accept`) and the approval-first auto-tour flow
 * (the `confirm_tour_inquiry` write tool, executed only after the manager
 * approves the proposed slot through the pending-action gate). Booking logic —
 * `resolveConfirmedEnd`, plannedEvent creation, competing-inquiry removal, and
 * `notifyTenantTourConfirmed` — lives here once so the two callers can never
 * drift apart on double-booking protection.
 */
import { PRODUCTION_APP_ORIGIN } from "@/lib/app-url";
import { syncPlannedTourToGoogleCalendar } from "@/lib/google-calendar/sync.server";
import { formatPacificDateTime } from "@/lib/pacific-time";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { notifyTenantTourConfirmed } from "@/lib/tour-notification-delivery.server";
import { isActivePlannedTourEvent } from "@/lib/tour-slot-math";
import { canAssign, normalizeAssignee, type WorkAssignee } from "@/lib/work-assignment";
import { createPrepareForTourTask } from "@/lib/manager-default-tasks.server";

type Db = ReturnType<typeof createSupabaseServiceRoleClient>;

export const INQUIRIES_RECORD_ID = "axis_admin_partner_inquiries_v1";
export const PLANNED_RECORD_ID = "axis_admin_planned_events_v1";
export const INQUIRY_EVENT_RECORD_TYPE = "partner_inquiry_request";

const MAX_EVENT_DURATION_MS = 480 * 60_000;

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function textField(row: Record<string, unknown> | null | undefined, key: string): string {
  const value = row?.[key];
  return typeof value === "string" ? value.trim() : "";
}

export function rowsFromRecord(rowData: unknown): Record<string, unknown>[] {
  const payload = asObject(rowData)?.payload;
  return Array.isArray(payload) ? payload.filter((item): item is Record<string, unknown> => Boolean(asObject(item))) : [];
}

type InquiryWindow = { start: string; end: string; managerUserId: string; adminLabel?: string; slotKey?: string };

function windowsFromInquiry(row: Record<string, unknown>): InquiryWindow[] {
  const requested = Array.isArray(row.requestedWindows) ? row.requestedWindows : [];
  const windows = requested
    .map(asObject)
    .filter((window): window is Record<string, unknown> => Boolean(window))
    .map((window) => ({
      start: textField(window, "start"),
      end: textField(window, "end"),
      managerUserId: textField(row, "managerUserId") || textField(window, "adminUserId"),
      adminLabel: textField(window, "adminLabel") || undefined,
      slotKey: textField(window, "slotKey") || undefined,
    }))
    .filter((window) => window.start && window.end && window.managerUserId);
  if (windows.length > 0) return windows;

  const start = textField(row, "proposedStart");
  const end = textField(row, "proposedEnd");
  const managerUserId = textField(row, "managerUserId") || textField(row, "adminUserId");
  return start && end && managerUserId
    ? [{ start, end, managerUserId, adminLabel: textField(row, "adminLabel") || undefined, slotKey: textField(row, "slotKey") || undefined }]
    : [];
}

function sameInstant(a: string | null | undefined, b: string): boolean {
  if (!a || !b) return false;
  const aMs = new Date(a).getTime();
  const bMs = new Date(b).getTime();
  return Number.isFinite(aMs) && Number.isFinite(bMs) && aMs === bMs;
}

function sameTourSlot(row: Record<string, unknown>, managerUserId: string, start: string, end: string): boolean {
  if (textField(row, "kind") !== "tour") return false;
  return windowsFromInquiry(row).some(
    (window) => window.managerUserId === managerUserId && sameInstant(window.start, start) && sameInstant(window.end, end),
  );
}

/** The manager may confirm with a custom duration; the end just has to be a sane time after the window's start. */
export function resolveConfirmedEnd(start: string, windowEnd: string, requestedEnd: string): string {
  const startMs = new Date(start).getTime();
  const requestedMs = requestedEnd ? new Date(requestedEnd).getTime() : Number.NaN;
  if (!Number.isFinite(startMs) || !Number.isFinite(requestedMs)) return windowEnd;
  if (requestedMs <= startMs || requestedMs - startMs > MAX_EVENT_DURATION_MS) return windowEnd;
  return requestedEnd;
}

export function formatRangeLabel(isoStart: string, isoEnd: string): string {
  const start = new Date(isoStart);
  const end = new Date(isoEnd);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return "Tour time";
  return `${formatPacificDateTime(start)} - ${formatPacificDateTime(end).replace(/^\w{3} \d{1,2}, /, "")}`;
}

/** True when a confirmed tour already occupies this manager's window (double-book guard). */
function plannedTourOccupiesWindow(
  plannedRows: Record<string, unknown>[],
  managerUserId: string,
  start: string,
  end: string,
): boolean {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return false;
  return plannedRows.some((event) => {
    if (textField(event, "kind") !== "tour") return false;
    if (!isActivePlannedTourEvent(event)) return false;
    if (textField(event, "managerUserId") !== managerUserId) return false;
    const evStart = new Date(textField(event, "start")).getTime();
    const evEnd = new Date(textField(event, "end")).getTime();
    if (![evStart, evEnd].every(Number.isFinite)) return false;
    return startMs < evEnd && evStart < endMs;
  });
}

export type ConfirmTourResult =
  | {
      ok: true;
      plannedEvent: Record<string, unknown>;
      message: string;
      tenantNotification: { ok: boolean; skipped?: boolean; error?: string } | null;
    }
  | { ok: false; status: number; error: string };

export type ConfirmTourOptions = {
  /** The pending inquiry id to confirm. */
  inquiryId: string;
  /** The acting manager. Must own the inquiry unless {@link isAdmin}. */
  actorUserId: string;
  isAdmin?: boolean;
  /** The chosen window start; falls back to the inquiry's first window. */
  requestedStart?: string;
  /** A custom end (bounded by {@link resolveConfirmedEnd}); falls back to the window end. */
  requestedEnd?: string;
  instructions?: string;
  notifyTenant: boolean;
  /** Manager-edited notification copy from the preview modal. */
  notificationSubject?: string;
  notificationBody?: string;
  /**
   * When true (the auto-approve/tool path), refuse to book a slot a confirmed
   * tour already occupies — the stale-proposal double-book guard. The manual
   * accept route leaves this off to preserve its existing override behavior.
   */
  guardDoubleBook?: boolean;
  /** Team member assigned to show the tour. */
  assignee?: WorkAssignee | null;
  /** Origin source for notification links; a prod-origin request is synthesized when absent. */
  req?: Request;
};

/**
 * Confirm a pending tour inquiry: create the planned tour event, drop the
 * inquiry and every competing inquiry that booked the same slot, delete their
 * per-window schedule rows, and (optionally) notify the tenant. Returns a
 * discriminated result the caller maps to an HTTP response or a tool reply.
 */
export async function confirmTourInquiry(db: Db, opts: ConfirmTourOptions): Promise<ConfirmTourResult> {
  const id = opts.inquiryId.trim();
  if (!id) return { ok: false, status: 400, error: "id required" };

  const { data: inquiryRecord, error: inquiryError } = await db
    .from("portal_schedule_records")
    .select("row_data")
    .eq("id", INQUIRIES_RECORD_ID)
    .maybeSingle();
  if (inquiryError) return { ok: false, status: 500, error: inquiryError.message };

  const inquiries = rowsFromRecord(inquiryRecord?.row_data);
  const row = inquiries.find((item) => textField(item, "id") === id);
  if (!row || textField(row, "kind") !== "tour" || textField(row, "status") !== "pending") {
    return { ok: false, status: 404, error: "Tour request not found." };
  }

  const managerUserId = textField(row, "managerUserId");
  if (!managerUserId || (!opts.isAdmin && managerUserId !== opts.actorUserId)) {
    return { ok: false, status: 403, error: "Unauthorized." };
  }

  const requestedStart = opts.requestedStart?.trim() ?? "";
  const requestedEnd = opts.requestedEnd?.trim() ?? "";
  const instructions = opts.instructions?.trim() ?? "";
  const assignee = normalizeAssignee(opts.assignee);
  if (assignee && !canAssign(assignee.type, "tour")) {
    return { ok: false, status: 400, error: "Invalid tour assignee." };
  }

  const windows = windowsFromInquiry(row);
  const selectedWindow =
    windows.find((window) => sameInstant(window.start, requestedStart) && sameInstant(window.end, requestedEnd)) ??
    windows.find((window) => sameInstant(window.start, requestedStart)) ??
    windows[0];
  if (!selectedWindow) return { ok: false, status: 400, error: "Tour window not found." };

  const groupId = textField(row, "tourGroupId");
  const start = selectedWindow.start;
  // Competing inquiries booked the original 30-min window, so slot clearing keys off windowEnd, not the custom end.
  const windowEnd = selectedWindow.end;
  const end = resolveConfirmedEnd(start, windowEnd, requestedEnd);

  const { data: plannedRecord, error: plannedReadError } = await db
    .from("portal_schedule_records")
    .select("row_data")
    .eq("id", PLANNED_RECORD_ID)
    .maybeSingle();
  if (plannedReadError) return { ok: false, status: 500, error: plannedReadError.message };
  const plannedRows = rowsFromRecord(plannedRecord?.row_data);

  if (opts.guardDoubleBook && plannedTourOccupiesWindow(plannedRows, managerUserId, start, windowEnd)) {
    return {
      ok: false,
      status: 409,
      error: "That time was already booked. Review this tour and pick another slot.",
    };
  }

  const plannedEvent: Record<string, unknown> = {
    id: crypto.randomUUID(),
    title: `Tour · ${textField(row, "name") || "Guest"}`,
    start,
    end,
    sourceInquiryId: id,
    kind: "tour",
    managerUserId,
    tourGroupId: groupId || undefined,
    propertyId: textField(row, "propertyId") || undefined,
    propertyTitle: textField(row, "propertyTitle") || undefined,
    roomLabel: textField(row, "roomLabel") || undefined,
    adminUserId: managerUserId,
    adminLabel: selectedWindow.adminLabel ?? (textField(row, "adminLabel") || undefined),
    slotKey: selectedWindow.slotKey ?? undefined,
    attendeeName: textField(row, "name") || undefined,
    attendeeEmail: textField(row, "email") || undefined,
    attendeePhone: textField(row, "phone") || undefined,
    notes: textField(row, "notes") || undefined,
    instructions: instructions || undefined,
    assignee: assignee ?? undefined,
  };

  const nextInquiries = inquiries.filter((candidate) => {
    if (textField(candidate, "id") === id) return false;
    if (groupId && textField(candidate, "tourGroupId") === groupId) return false;
    return !sameTourSlot(candidate, managerUserId, start, windowEnd);
  });

  const { error: writeError } = await db.from("portal_schedule_records").upsert(
    [
      {
        id: INQUIRIES_RECORD_ID,
        manager_user_id: null,
        property_id: null,
        record_type: INQUIRIES_RECORD_ID,
        row_data: {
          id: INQUIRIES_RECORD_ID,
          recordType: INQUIRIES_RECORD_ID,
          managerUserId: null,
          propertyId: null,
          payload: nextInquiries,
        },
        updated_at: new Date().toISOString(),
      },
      {
        id: PLANNED_RECORD_ID,
        manager_user_id: null,
        property_id: textField(row, "propertyId") || null,
        record_type: PLANNED_RECORD_ID,
        starts_at: start,
        ends_at: end,
        row_data: {
          id: PLANNED_RECORD_ID,
          recordType: PLANNED_RECORD_ID,
          managerUserId: null,
          propertyId: null,
          payload: [...plannedRows, plannedEvent],
        },
        updated_at: new Date().toISOString(),
      },
    ],
    { onConflict: "id" },
  );
  if (writeError) return { ok: false, status: 500, error: writeError.message };

  const eventIds = inquiries
    .filter((candidate) => {
      if (textField(candidate, "id") === id) return true;
      if (groupId && textField(candidate, "tourGroupId") === groupId) return true;
      return sameTourSlot(candidate, managerUserId, start, windowEnd);
    })
    .map((candidate) => `${INQUIRY_EVENT_RECORD_TYPE}_${textField(candidate, "id")}_0`)
    .filter(Boolean);
  if (eventIds.length > 0) {
    const { error: deleteError } = await db.from("portal_schedule_records").delete().in("id", eventIds);
    if (deleteError) return { ok: false, status: 500, error: deleteError.message };
  }

  let tenantNotification: { ok: boolean; skipped?: boolean; error?: string } | null = null;
  if (opts.notifyTenant) {
    // The tool path has no live request; links then resolve to the production
    // origin, which is correct for a confirmed-tour email.
    const notifyReq = opts.req ?? new Request(PRODUCTION_APP_ORIGIN);
    tenantNotification = await notifyTenantTourConfirmed(
      db,
      notifyReq,
      row,
      { start, end, managerUserId, adminLabel: selectedWindow.adminLabel },
      instructions || undefined,
      {
        subject: opts.notificationSubject,
        body: opts.notificationBody,
      },
    );
  }

  void syncPlannedTourToGoogleCalendar(db, managerUserId, {
    plannedEventId: String(plannedEvent.id),
    title: String(plannedEvent.title),
    start,
    end,
    propertyTitle: textField(row, "propertyTitle") || undefined,
    attendeeName: textField(row, "name") || undefined,
    attendeeEmail: textField(row, "email") || undefined,
    attendeePhone: textField(row, "phone") || undefined,
    notes: textField(row, "notes") || undefined,
    instructions: instructions || undefined,
  }).catch(() => undefined);

  void createPrepareForTourTask(db, managerUserId, {
    inquiryId: id,
    tourStart: start,
    guestName: textField(row, "name"),
    propertyTitle: textField(row, "propertyTitle"),
    propertyId: textField(row, "propertyId"),
    roomLabel: textField(row, "roomLabel"),
    plannedEventId: String(plannedEvent.id),
  }).catch(() => undefined);

  return { ok: true, plannedEvent, message: formatRangeLabel(start, end), tenantNotification };
}
