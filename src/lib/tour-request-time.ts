/**
 * "Request any time" for a tour: the pure rules shared by the booking flow (browser) and
 * `createTourInquiry` (server). Used ONLY when a house has no open published slots.
 *
 * A requested time is wall time on the same Pacific calendar every slotKey is read on
 * (`tour-slot-math.ts`): 30-minute steps from 8:00 AM through 7:30 PM, any day from tomorrow
 * for the next 60 days. It is a request, never a hold: nothing is booked until a manager
 * confirms, and confirming runs the double-book check.
 */
import { formatPacificDate, pacificCalendarDateYmd } from "@/lib/pacific-time";
import { slotKeyForInstant, slotStartMs, TOUR_SLOT_DURATION_MS } from "@/lib/tour-slot-math";

/** The `requestKind` stored on an inquiry filed in this mode. Server-owned: a client claim is re-checked. */
export const REQUESTED_TOUR_KIND = "requested_time";

/** 8:00 AM (slot 16) through the 7:30 PM slot (39), the last that ends by 8:00 PM. */
export const REQUESTED_TOUR_FIRST_SLOT = 16;
export const REQUESTED_TOUR_LAST_SLOT = 39;
export const REQUESTED_TOUR_DAYS_AHEAD = 60;

export function requestedTourSlotIndices(): number[] {
  const out: number[] = [];
  for (let i = REQUESTED_TOUR_FIRST_SLOT; i <= REQUESTED_TOUR_LAST_SLOT; i += 1) out.push(i);
  return out;
}

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Calendar arithmetic on a `YYYY-MM-DD` string (never instant math: a DST day is 23 or 25 hours). */
export function addDaysToYmd(ymd: string, days: number): string {
  const match = YMD.exec(ymd);
  if (!match) return ymd;
  const shifted = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/** Every day a visitor may request, soonest first: tomorrow (Pacific) through the next 60 days. */
export function requestedTourDates(now: number = Date.now()): string[] {
  const today = pacificCalendarDateYmd(now);
  return Array.from({ length: REQUESTED_TOUR_DAYS_AHEAD }, (_, i) => addDaysToYmd(today, i + 1));
}

/** True for a `YYYY-MM-DD` that is a real calendar day. */
function isRealYmd(ymd: string): boolean {
  const match = YMD.exec(ymd);
  if (!match) return false;
  return addDaysToYmd(ymd, 0) === ymd;
}

/** "4:00 PM" for a 0-47 slot index. */
export function formatRequestedTourTime(slotIndex: number): string {
  const mins = slotIndex * 30;
  const h24 = Math.floor(mins / 60);
  const m = mins % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${h24 < 12 ? "AM" : "PM"}`;
}

/** "Thu, Oct 29" for a Pacific calendar date. */
export function formatRequestedTourDay(ymd: string): string {
  return formatPacificDate(ymd, { weekday: "short", month: "short", day: "numeric" });
}

/** The caption under the picker: "Thu, Oct 29 at 4:00 PM · request". */
export function requestedTourCaption(ymd: string, slotIndex: number): string {
  return `${formatRequestedTourDay(ymd)} at ${formatRequestedTourTime(slotIndex)} · request`;
}

/** "Thu, Oct 29 at 4:00 PM" for a stored instant, read on the Pacific wall clock. */
export function formatRequestedTourWhen(startIso: string): string {
  const ms = Date.parse(startIso);
  if (!Number.isFinite(ms)) return "";
  const day = formatPacificDate(ms, { weekday: "short", month: "short", day: "numeric" });
  const time = formatPacificDate(ms, { hour: "numeric", minute: "2-digit" });
  return `${day} at ${time}`;
}

export type RequestedTourWindow = { slotKey: string; start: string; end: string };

/**
 * Validate a requested start instant and return the window it names, or the reason it is refused.
 * The slotKey is DERIVED from the instant (`slotKeyForInstant`), never taken from the caller, and the
 * instant must sit exactly on a 30-minute Pacific boundary, inside 8:00 AM-7:30 PM, from tomorrow on.
 */
export function resolveRequestedTourWindow(
  startIso: string,
  now: number = Date.now(),
): { ok: true; window: RequestedTourWindow } | { ok: false; error: string } {
  const instant = Date.parse(startIso);
  if (!Number.isFinite(instant)) return { ok: false, error: "Choose a day and time for your tour." };
  const slotKey = slotKeyForInstant(new Date(instant).toISOString());
  const slotStart = slotKey ? slotStartMs(slotKey) : null;
  if (!slotKey || slotStart === null || slotStart !== instant) {
    return { ok: false, error: "Tour times are on the hour or half hour." };
  }
  const [dateStr, indexText] = slotKey.split(":");
  const slotIndex = Number(indexText);
  if (slotIndex < REQUESTED_TOUR_FIRST_SLOT || slotIndex > REQUESTED_TOUR_LAST_SLOT) {
    return { ok: false, error: "Tour times run from 8:00 AM to 8:00 PM Pacific." };
  }
  const today = pacificCalendarDateYmd(now);
  const tomorrow = addDaysToYmd(today, 1);
  const last = addDaysToYmd(today, REQUESTED_TOUR_DAYS_AHEAD);
  if (!dateStr || !isRealYmd(dateStr) || dateStr < tomorrow || dateStr > last) {
    return { ok: false, error: "Choose a day from tomorrow through the next 60 days." };
  }
  return {
    ok: true,
    window: { slotKey, start: new Date(slotStart).toISOString(), end: new Date(slotStart + TOUR_SLOT_DURATION_MS).toISOString() },
  };
}
