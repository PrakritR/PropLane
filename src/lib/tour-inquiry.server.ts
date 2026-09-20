/** Shared tour-inquiry parsing plus the legacy entry point, which delegates
 * every acceptance mutation to the advisory-locked confirmation core. */
import { formatPacificDateTime } from "@/lib/pacific-time";
import type { PlannedTourCalendarSync } from "@/lib/google-calendar/planned-tour-sync.server";
import type { TourNotificationChannels } from "@/lib/tour-notification-delivery.server";

type Db = ReturnType<typeof import("@/lib/supabase/service").createSupabaseServiceRoleClient>;
export const INQUIRIES_RECORD_ID = "axis_admin_partner_inquiries_v1";
export const PLANNED_RECORD_ID = "axis_admin_planned_events_v1";

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function textField(row: Record<string, unknown> | null | undefined, key: string): string {
  const value = row?.[key];
  return typeof value === "string" ? value.trim() : "";
}
export function rowsFromRecord(rowData: unknown): Record<string, unknown>[] {
  const payload = asObject(rowData)?.payload;
  return Array.isArray(payload) ? payload.filter((item): item is Record<string, unknown> => Boolean(asObject(item))) : [];
}
export type TourInquiryWindow = { start: string; end: string; managerUserId: string; adminLabel?: string };
export function windowsFromInquiry(row: Record<string, unknown>): TourInquiryWindow[] {
  const requested = Array.isArray(row.requestedWindows) ? row.requestedWindows : [];
  const windows = requested.map(asObject).filter((window): window is Record<string, unknown> => Boolean(window)).map((window) => ({
    start: textField(window, "start"), end: textField(window, "end"),
    managerUserId: textField(row, "managerUserId") || textField(window, "adminUserId"),
    adminLabel: textField(window, "adminLabel") || undefined,
  })).filter((window) => window.start && window.end && window.managerUserId);
  if (windows.length > 0) return windows;
  const start = textField(row, "proposedStart");
  const end = textField(row, "proposedEnd");
  const managerUserId = textField(row, "managerUserId") || textField(row, "adminUserId");
  return start && end && managerUserId ? [{ start, end, managerUserId, adminLabel: textField(row, "adminLabel") || undefined }] : [];
}
function sameInstant(a: string | null | undefined, b: string): boolean {
  if (!a || !b) return false;
  const aMs = new Date(a).getTime();
  const bMs = new Date(b).getTime();
  return Number.isFinite(aMs) && Number.isFinite(bMs) && aMs === bMs;
}
export function selectTourWindow(row: Record<string, unknown>, requestedStart: string, requestedEnd: string): TourInquiryWindow | null {
  const windows = windowsFromInquiry(row);
  return windows.find((window) => sameInstant(window.start, requestedStart) && sameInstant(window.end, requestedEnd))
    ?? windows.find((window) => sameInstant(window.start, requestedStart)) ?? windows[0] ?? null;
}
const MAX_EVENT_DURATION_MS = 480 * 60_000;
export function resolveConfirmedTourEnd(start: string, windowEnd: string, requestedEnd: string): string {
  const startMs = new Date(start).getTime();
  const requestedMs = requestedEnd ? new Date(requestedEnd).getTime() : Number.NaN;
  if (!Number.isFinite(startMs) || !Number.isFinite(requestedMs)) return windowEnd;
  if (requestedMs <= startMs || requestedMs - startMs > MAX_EVENT_DURATION_MS) return windowEnd;
  return requestedEnd;
}
export function formatTourRangeLabel(isoStart: string, isoEnd: string): string {
  const start = new Date(isoStart); const end = new Date(isoEnd);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return "Tour time";
  return `${formatPacificDateTime(start)} - ${formatPacificDateTime(end).replace(/^\w{3} \d{1,2}, /, "")}`;
}
export type AcceptTourInquiryResult =
  | { ok: true; plannedEvent: Record<string, unknown>; message: string; tenantNotification: { ok: boolean; skipped?: boolean; error?: string } | null; calendarSync: PlannedTourCalendarSync }
  | { ok: false; status: 400 | 403 | 404 | 500; error: string };
export type AcceptTourInquiryOptions = {
  inquiryId: string; start?: string; end?: string; instructions?: string; notifyTenant?: boolean; request?: Request; allowAnyManager?: boolean;
  notificationChannels?: TourNotificationChannels;
};
export async function acceptTourInquiry(db: Db, managerUserId: string, opts: AcceptTourInquiryOptions): Promise<AcceptTourInquiryResult> {
  // Keep constants and pure inquiry parsers safe to import from auth/public
  // read paths. The confirmation graph includes notification writers and is
  // needed only for this legacy mutation entry point.
  const { confirmTourInquiry: confirmTourInquiryCore } = await import("@/lib/tour-inquiry-confirm.server");
  return (await confirmTourInquiryCore(db, {
    inquiryId: opts.inquiryId, actorUserId: managerUserId, isAdmin: opts.allowAnyManager === true,
    requestedStart: opts.start, requestedEnd: opts.end, instructions: opts.instructions,
    notifyTenant: opts.notifyTenant === true, req: opts.request, guardDoubleBook: false,
    notificationChannels: opts.notificationChannels,
  })) as AcceptTourInquiryResult;
}
