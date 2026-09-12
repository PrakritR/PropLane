/**
 * Server-side tour-inquiry acceptance — the single implementation behind both
 * the /api/portal-tour-inquiries/accept route and the agent's
 * accept_tour_inquiry tool.
 *
 * Tour requests live inside a SHARED singleton schedule record
 * (axis_admin_partner_inquiries_v1) whose row_data.payload array holds every
 * manager's inquiries; confirmed events live in a second singleton
 * (axis_admin_planned_events_v1). Acceptance is therefore a whole-singleton
 * read-merge-write: remove the accepted inquiry (and competing requests for
 * the same slot), append a planned event, and delete the per-window standalone
 * inquiry records. Ownership is enforced per item — the caller may only accept
 * an inquiry whose managerUserId matches, unless allowAnyManager (admin route).
 */
import { formatPacificDateTime } from "@/lib/pacific-time";
import { resolveShareableAppOrigin } from "@/lib/app-url";
import {
  runPlannedTourCalendarSync,
  type PlannedTourCalendarSync,
} from "@/lib/google-calendar/planned-tour-sync.server";
import { syncPlannedTourToGoogleCalendar } from "@/lib/google-calendar/sync.server";
import { notifyTenantTourConfirmed } from "@/lib/tour-notification-delivery.server";

type Db = ReturnType<typeof import("@/lib/supabase/service").createSupabaseServiceRoleClient>;

export const INQUIRIES_RECORD_ID = "axis_admin_partner_inquiries_v1";
export const PLANNED_RECORD_ID = "axis_admin_planned_events_v1";
const INQUIRY_EVENT_RECORD_TYPE = "partner_inquiry_request";

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function textField(row: Record<string, unknown> | null | undefined, key: string): string {
  const value = row?.[key];
  return typeof value === "string" ? value.trim() : "";
}

/** Items of a singleton schedule record's row_data.payload array. */
export function rowsFromRecord(rowData: unknown): Record<string, unknown>[] {
  const payload = asObject(rowData)?.payload;
  return Array.isArray(payload) ? payload.filter((item): item is Record<string, unknown> => Boolean(asObject(item))) : [];
}

export type TourInquiryWindow = { start: string; end: string; managerUserId: string; adminLabel?: string };

/** Requested tour windows, falling back to the single proposedStart/End pair. */
export function windowsFromInquiry(row: Record<string, unknown>): TourInquiryWindow[] {
  const requested = Array.isArray(row.requestedWindows) ? row.requestedWindows : [];
  const windows = requested
    .map(asObject)
    .filter((window): window is Record<string, unknown> => Boolean(window))
    .map((window) => ({
      start: textField(window, "start"),
      end: textField(window, "end"),
      managerUserId: textField(row, "managerUserId") || textField(window, "adminUserId"),
      adminLabel: textField(window, "adminLabel") || undefined,
    }))
    .filter((window) => window.start && window.end && window.managerUserId);
  if (windows.length > 0) return windows;

  const start = textField(row, "proposedStart");
  const end = textField(row, "proposedEnd");
  const managerUserId = textField(row, "managerUserId") || textField(row, "adminUserId");
  return start && end && managerUserId
    ? [{ start, end, managerUserId, adminLabel: textField(row, "adminLabel") || undefined }]
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

/** The window the manager is confirming: exact start+end match, then start-only, then the first. */
export function selectTourWindow(
  row: Record<string, unknown>,
  requestedStart: string,
  requestedEnd: string,
): TourInquiryWindow | null {
  const windows = windowsFromInquiry(row);
  return (
    windows.find((window) => sameInstant(window.start, requestedStart) && sameInstant(window.end, requestedEnd)) ??
    windows.find((window) => sameInstant(window.start, requestedStart)) ??
    windows[0] ??
    null
  );
}

const MAX_EVENT_DURATION_MS = 480 * 60_000;

/** The manager may confirm with a custom duration; the end just has to be a sane time after the window's start. */
export function resolveConfirmedTourEnd(start: string, windowEnd: string, requestedEnd: string): string {
  const startMs = new Date(start).getTime();
  const requestedMs = requestedEnd ? new Date(requestedEnd).getTime() : Number.NaN;
  if (!Number.isFinite(startMs) || !Number.isFinite(requestedMs)) return windowEnd;
  if (requestedMs <= startMs || requestedMs - startMs > MAX_EVENT_DURATION_MS) return windowEnd;
  return requestedEnd;
}

export function formatTourRangeLabel(isoStart: string, isoEnd: string): string {
  const start = new Date(isoStart);
  const end = new Date(isoEnd);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return "Tour time";
  return `${formatPacificDateTime(start)} - ${formatPacificDateTime(end).replace(/^\w{3} \d{1,2}, /, "")}`;
}

export type AcceptTourInquiryResult =
  | {
      ok: true;
      plannedEvent: Record<string, unknown>;
      message: string;
      tenantNotification: { ok: boolean; skipped?: boolean; error?: string } | null;
      /** The push onto the manager's linked Google Calendar; `skipped` when none is linked. */
      calendarSync: PlannedTourCalendarSync;
    }
  | { ok: false; status: 400 | 403 | 404 | 500; error: string };

export type AcceptTourInquiryOptions = {
  inquiryId: string;
  /** Requested window start; empty/omitted falls back to the first requested window. */
  start?: string;
  /** Requested (possibly custom-duration) end; sanity-checked against the window. */
  end?: string;
  /** Host instructions stored on the event and included in the guest email. */
  instructions?: string;
  /** When true, email + inbox-notify the guest that the tour is confirmed. */
  notifyTenant?: boolean;
  /** Origin-bearing request for notification links; a canonical-origin fallback is used when absent. */
  request?: Request;
  /** Admins may accept on behalf of any manager (route-only override). */
  allowAnyManager?: boolean;
};

export async function acceptTourInquiry(
  db: Db,
  managerUserId: string,
  opts: AcceptTourInquiryOptions,
): Promise<AcceptTourInquiryResult> {
  const id = opts.inquiryId.trim();
  const requestedStart = opts.start?.trim() ?? "";
  const requestedEnd = opts.end?.trim() ?? "";
  const instructions = opts.instructions?.trim() ?? "";
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

  const rowManagerUserId = textField(row, "managerUserId");
  if (!rowManagerUserId || (!opts.allowAnyManager && rowManagerUserId !== managerUserId)) {
    return { ok: false, status: 403, error: "Unauthorized." };
  }

  const selectedWindow = selectTourWindow(row, requestedStart, requestedEnd);
  if (!selectedWindow) return { ok: false, status: 400, error: "Tour window not found." };

  const groupId = textField(row, "tourGroupId");
  const start = selectedWindow.start;
  // Competing inquiries booked the original 30-min window, so slot clearing keys off windowEnd, not the custom end.
  const windowEnd = selectedWindow.end;
  const end = resolveConfirmedTourEnd(start, windowEnd, requestedEnd);
  const plannedEvent = {
    id: crypto.randomUUID(),
    title: `Tour · ${textField(row, "name") || "Guest"}`,
    start,
    end,
    sourceInquiryId: id,
    kind: "tour",
    managerUserId: rowManagerUserId,
    tourGroupId: groupId || undefined,
    propertyId: textField(row, "propertyId") || undefined,
    propertyTitle: textField(row, "propertyTitle") || undefined,
    roomLabel: textField(row, "roomLabel") || undefined,
    adminUserId: rowManagerUserId,
    adminLabel: selectedWindow.adminLabel ?? (textField(row, "adminLabel") || undefined),
    attendeeName: textField(row, "name") || undefined,
    attendeeEmail: textField(row, "email") || undefined,
    attendeePhone: textField(row, "phone") || undefined,
    smsConsent: row.smsConsent === true,
    // Preserve the server-owned channel provenance. Otherwise this second
    // confirmation path turns a known non-SMS inquiry into an ambiguous legacy
    // planned event that can consult historical conversation evidence.
    ...(typeof row.smsOrigin === "string" ? { smsOrigin: row.smsOrigin } : {}),
    notes: textField(row, "notes") || undefined,
    instructions: instructions || undefined,
  };

  const nextInquiries = inquiries.filter((candidate) => {
    if (textField(candidate, "id") === id) return false;
    if (groupId && textField(candidate, "tourGroupId") === groupId) return false;
    return !sameTourSlot(candidate, rowManagerUserId, start, windowEnd);
  });

  const { data: plannedRecord, error: plannedReadError } = await db
    .from("portal_schedule_records")
    .select("row_data")
    .eq("id", PLANNED_RECORD_ID)
    .maybeSingle();
  if (plannedReadError) return { ok: false, status: 500, error: plannedReadError.message };
  const plannedRows = rowsFromRecord(plannedRecord?.row_data);

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
      return sameTourSlot(candidate, rowManagerUserId, start, windowEnd);
    })
    .map((candidate) => `${INQUIRY_EVENT_RECORD_TYPE}_${textField(candidate, "id")}_0`)
    .filter(Boolean);
  if (eventIds.length > 0) {
    const { error: deleteError } = await db.from("portal_schedule_records").delete().in("id", eventIds);
    if (deleteError) return { ok: false, status: 500, error: deleteError.message };
  }

  let tenantNotification: { ok: boolean; skipped?: boolean; error?: string } | null = null;
  if (opts.notifyTenant === true) {
    const request = opts.request ?? new Request(resolveShareableAppOrigin());
    tenantNotification = await notifyTenantTourConfirmed(
      db,
      request,
      row,
      {
        start,
        end,
        managerUserId: rowManagerUserId,
        adminLabel: selectedWindow.adminLabel,
      },
      instructions || undefined,
    );
  }

  // Awaited for the same reason as `confirmTourInquiry`: a fire-and-forget
  // push can be frozen with the serverless instance before Google hears of it.
  const calendarSync = await runPlannedTourCalendarSync(() =>
    syncPlannedTourToGoogleCalendar(db, rowManagerUserId, {
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
    }),
  );

  return { ok: true, plannedEvent, message: formatTourRangeLabel(start, end), tenantNotification, calendarSync };
}
