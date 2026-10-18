/**
 * Exact check-in and check-out times for a stay (bookings-times-1018).
 *
 * A stay's DATES stay authoritative everywhere (checkout exclusive, the
 * capacity trigger, occupancy). The TIMES ride beside them as property wall
 * clock "HH:MM" strings: `checkInTime` on the check-in date, `checkOutTime` on
 * the checkout date, read in the property's own time zone
 * (`propertyTimeZoneForZip`). A stay that carries no time of its own reads the
 * property's defaults (`listingSubmission.stayTimes`), else 3:00 pm / 11:00 am.
 *
 * Every consumer goes through this one module: the calendar's half-day bars,
 * the overlap check, the paid early check-in / late checkout availability rule,
 * and `bookingTimeline` (when the arrival guide, the checkout reminder and the
 * turnover clean happen). Framework-free and pure.
 */

import { zonedWallTimeMs } from "@/lib/tour-slot-math";

export type StayAddOnKind = "early_check_in" | "late_check_out";

export const STAY_ADD_ON_KINDS: readonly StayAddOnKind[] = ["early_check_in", "late_check_out"];

/** Per-property defaults, stored at `listingSubmission.stayTimes`. */
export type PropertyStayTimes = {
  /** Standard check-in, "HH:MM" 24h property wall time. Default "15:00". */
  checkInTime: string;
  /** Standard check-out. Default "11:00". */
  checkOutTime: string;
  /** Minimum turnover between one guest out and the next in. Default 180. */
  cleaningBufferMinutes: number;
  /** Earliest a paid early check-in may start. Default "12:00". */
  earliestEarlyCheckIn: string;
  /** Latest a paid late checkout may end. Default "14:00". */
  latestLateCheckOut: string;
  /** Price of the early check-in add-on, cents. Default 2500. */
  earlyCheckInPriceCents: number;
  /** Price of the late checkout add-on, cents. Default 2500. */
  lateCheckOutPriceCents: number;
};

export const DEFAULT_PROPERTY_STAY_TIMES: PropertyStayTimes = Object.freeze({
  checkInTime: "15:00",
  checkOutTime: "11:00",
  cleaningBufferMinutes: 180,
  earliestEarlyCheckIn: "12:00",
  latestLateCheckOut: "14:00",
  earlyCheckInPriceCents: 2500,
  lateCheckOutPriceCents: 2500,
});

/**
 * One add-on on one stay, stored at `row_data.stayDetails.addOns[kind]`.
 * `requested` = asked for at booking, no charge yet (raised on confirm);
 * `pending` = charge raised, unpaid; `paid` = time applied to the stay;
 * `refunded` = paid but could not be honored, refunded automatically;
 * `refund_failed` = paid, could not be honored, and the automatic refund hit a terminal refusal: the host refunds it from Payments.
 */
export type StayAddOnStatus = "requested" | "pending" | "paid" | "refunded" | "refund_failed";

export type StayAddOnRecord = {
  time: string;
  priceCents: number;
  status: StayAddOnStatus;
  chargeId?: string;
  requestedAt?: string;
  paidAt?: string;
  refundedAt?: string;
  refundReason?: string;
};

export type StayAddOns = Partial<Record<StayAddOnKind, StayAddOnRecord>>;

const TIME_PATTERN = /^([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/;

/** "15:00" for any valid 24h "H:MM" / "HH:MM[:SS]"; null otherwise. */
export function normalizeStayTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = TIME_PATTERN.exec(value.trim());
  if (!match) return null;
  return `${match[1]!.padStart(2, "0")}:${match[2]}`;
}

export function stayTimeMinutes(time: string): number {
  const normalized = normalizeStayTime(time) ?? "00:00";
  const [hours, minutes] = normalized.split(":").map(Number);
  return hours! * 60 + minutes!;
}

function minutesToStayTime(total: number): string {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, Math.round(total)));
  return `${String(Math.floor(clamped / 60)).padStart(2, "0")}:${String(clamped % 60).padStart(2, "0")}`;
}

function nonNegativeInt(value: unknown, fallback: number, max: number): number {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number) || number < 0) return fallback;
  return Math.min(max, Math.round(number));
}

/** Property defaults from whatever is stored; every missing or bad field takes its default. */
export function normalizePropertyStayTimes(raw: unknown): PropertyStayTimes {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_PROPERTY_STAY_TIMES;
  return {
    checkInTime: normalizeStayTime(source.checkInTime) ?? d.checkInTime,
    checkOutTime: normalizeStayTime(source.checkOutTime) ?? d.checkOutTime,
    cleaningBufferMinutes: nonNegativeInt(source.cleaningBufferMinutes, d.cleaningBufferMinutes, 24 * 60),
    earliestEarlyCheckIn: normalizeStayTime(source.earliestEarlyCheckIn) ?? d.earliestEarlyCheckIn,
    latestLateCheckOut: normalizeStayTime(source.latestLateCheckOut) ?? d.latestLateCheckOut,
    earlyCheckInPriceCents: nonNegativeInt(source.earlyCheckInPriceCents, d.earlyCheckInPriceCents, 100_000_00),
    lateCheckOutPriceCents: nonNegativeInt(source.lateCheckOutPriceCents, d.lateCheckOutPriceCents, 100_000_00),
  };
}

/** "3:00 pm", "12:00 pm", "11:30 am". */
export function formatStayTime(time: string): string {
  const minutes = stayTimeMinutes(time);
  const hours24 = Math.floor(minutes / 60);
  const suffix = hours24 >= 12 ? "pm" : "am";
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return `${hours12}:${String(minutes % 60).padStart(2, "0")} ${suffix}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Oct 19, 11:00 am". */
export function formatStayMoment(dateKey: string, time: string): string {
  const [, month, day] = dateKey.split("-").map(Number);
  return `${MONTHS[(month ?? 1) - 1]} ${day}, ${formatStayTime(time)}`;
}

/** The fields a stay may carry about its own times (row_data or an entry). */
export type StayTimeSource = {
  checkInTime?: string | null;
  checkOutTime?: string | null;
  /** Legacy `stayDetails.earlyCheckIn` "HH:MM" the Add/Edit sheet used to write. */
  legacyEarlyCheckIn?: string | null;
  /** Legacy `stayDetails.lateCheckOut`. */
  legacyLateCheckOut?: string | null;
};

/** The stay's own times: explicit, else the legacy sheet field, else the property default. */
export function resolveStayTimes(
  stay: StayTimeSource,
  property: PropertyStayTimes = DEFAULT_PROPERTY_STAY_TIMES,
): { checkInTime: string; checkOutTime: string } {
  return {
    checkInTime:
      normalizeStayTime(stay.checkInTime) ?? normalizeStayTime(stay.legacyEarlyCheckIn) ?? property.checkInTime,
    checkOutTime:
      normalizeStayTime(stay.checkOutTime) ?? normalizeStayTime(stay.legacyLateCheckOut) ?? property.checkOutTime,
  };
}

/** A stay on one room with resolved times; `checkOut` is the exclusive checkout DATE. */
export type TimedStay = {
  id: string;
  checkIn: string;
  checkOut: string;
  checkInTime: string;
  checkOutTime: string;
};

function dateKeyDays(dateKey: string): number {
  const [year, month, day] = dateKey.split("-").map(Number);
  return Math.round(Date.UTC(year!, (month ?? 1) - 1, day ?? 1) / 86_400_000);
}

/**
 * Minutes on the property's wall clock, comparable across stays of one
 * property (no time zone needed — every stay on a room shares one).
 */
export function wallMinutes(dateKey: string, time: string): number {
  return dateKeyDays(dateKey) * 1440 + stayTimeMinutes(time);
}

export function stayStartWall(stay: TimedStay): number {
  return wallMinutes(stay.checkIn, stay.checkInTime);
}

export function stayEndWall(stay: TimedStay): number {
  return wallMinutes(stay.checkOut, stay.checkOutTime);
}

/**
 * Two stays overlap when their [in, out) wall-time intervals intersect. An
 * 11:00 am checkout and a 3:00 pm check-in on the same day do NOT overlap.
 */
export function staysOverlap(a: TimedStay, b: TimedStay): boolean {
  return stayStartWall(a) < stayEndWall(b) && stayStartWall(b) < stayEndWall(a);
}

const NOON = 12 * 60;

/**
 * Fractional day-cell span of a stay's bar, relative to `firstDay`:
 * check-in at or after noon starts mid-cell, before noon at the cell's start;
 * check-out at or before noon ends mid-cell, after noon at the cell's end.
 * A same-day turnover is two half bars side by side.
 */
export function halfDayBarSpan(
  stay: Pick<TimedStay, "checkIn" | "checkOut" | "checkInTime" | "checkOutTime">,
  firstDay: string,
): { start: number; end: number } {
  const base = dateKeyDays(firstDay);
  const start = dateKeyDays(stay.checkIn) - base + (stayTimeMinutes(stay.checkInTime) >= NOON ? 0.5 : 0);
  const end = dateKeyDays(stay.checkOut) - base + (stayTimeMinutes(stay.checkOutTime) <= NOON ? 0.5 : 1);
  return { start, end: Math.max(end, start + 0.5) };
}

export type StayAddOnUnavailableReason =
  | "outside_window"
  | "previous_guest"
  | "next_guest"
  | "not_earlier"
  | "not_later";

export type StayAddOnAvailability =
  | { available: true; kind: StayAddOnKind; time: string; priceCents: number }
  | { available: false; kind: StayAddOnKind; reason: StayAddOnUnavailableReason };

/**
 * Whether a paid early check-in / late checkout can be offered for `stay`.
 *
 * Early: the requested time (default the property's earliest) is at or after
 * `earliestEarlyCheckIn` and before the stay's own check-in, and every other
 * stay on the room is out at least `cleaningBufferMinutes` before it.
 * Late: the requested time (default the property's latest) is after the stay's
 * own checkout and at or before `latestLateCheckOut`, and every other stay
 * that starts after this one still leaves the buffer.
 *
 * `others` are the room's other live stays (the caller drops cancelled ones
 * and the stay itself). Conservative on a shared room: any other stay counts.
 */
export function stayAddOnAvailability(
  kind: StayAddOnKind,
  args: { stay: TimedStay; others: readonly TimedStay[]; times: PropertyStayTimes; requestedTime?: string | null },
): StayAddOnAvailability {
  const { stay, times } = args;
  const others = args.others.filter((other) => other.id !== stay.id);
  const buffer = times.cleaningBufferMinutes;
  if (kind === "early_check_in") {
    const time = normalizeStayTime(args.requestedTime) ?? times.earliestEarlyCheckIn;
    if (stayTimeMinutes(time) < stayTimeMinutes(times.earliestEarlyCheckIn)) {
      return { available: false, kind, reason: "outside_window" };
    }
    if (stayTimeMinutes(time) >= stayTimeMinutes(stay.checkInTime)) {
      return { available: false, kind, reason: "not_earlier" };
    }
    const start = wallMinutes(stay.checkIn, time);
    const blocked = others.some((other) => stayStartWall(other) < stayEndWall(stay) && stayEndWall(other) + buffer > start);
    if (blocked) return { available: false, kind, reason: "previous_guest" };
    return { available: true, kind, time, priceCents: times.earlyCheckInPriceCents };
  }
  const time = normalizeStayTime(args.requestedTime) ?? times.latestLateCheckOut;
  if (stayTimeMinutes(time) > stayTimeMinutes(times.latestLateCheckOut)) {
    return { available: false, kind, reason: "outside_window" };
  }
  if (stayTimeMinutes(time) <= stayTimeMinutes(stay.checkOutTime)) {
    return { available: false, kind, reason: "not_later" };
  }
  const end = wallMinutes(stay.checkOut, time);
  const blocked = others.some((other) => stayEndWall(other) > stayStartWall(stay) && stayStartWall(other) < end + buffer);
  if (blocked) return { available: false, kind, reason: "next_guest" };
  return { available: true, kind, time, priceCents: times.lateCheckOutPriceCents };
}

/** The instant (ISO, UTC) a property wall time occurs at. */
export function wallInstantIso(dateKey: string, time: string, timeZone: string): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(zonedWallTimeMs(year!, month!, day!, stayTimeMinutes(time), timeZone)).toISOString();
}

export type BookingTimeline = {
  checkInAt: string;
  checkOutAt: string;
  /** Arrival guide text to the guest: 24 h before check-in. */
  arrivalGuideAt: string;
  /** Checkout reminder to the guest: 8:00 am on checkout day (an hour before an earlier checkout). */
  checkoutReminderAt: string;
  /** Turnover clean: from this checkout to the next check-in on the room (else checkout + buffer). */
  cleaningWindow: { startAt: string; endAt: string; shortGap: boolean };
};

/**
 * Every moment a stay's times drive. Register sends against these, never a
 * second derivation: the reminder sweeper, the cleaning dispatch and the
 * calendar all read the same answer.
 */
export function bookingTimeline(
  booking: Pick<TimedStay, "checkIn" | "checkOut" | "checkInTime" | "checkOutTime">,
  options: {
    times: PropertyStayTimes;
    timeZone: string;
    nextCheckIn?: { date: string; time: string } | null;
  },
): BookingTimeline {
  const { times, timeZone } = options;
  const checkInAt = wallInstantIso(booking.checkIn, booking.checkInTime, timeZone);
  const checkOutAt = wallInstantIso(booking.checkOut, booking.checkOutTime, timeZone);
  const reminderMinutes = Math.min(8 * 60, stayTimeMinutes(booking.checkOutTime) - 60);
  const checkoutReminderAt = wallInstantIso(booking.checkOut, minutesToStayTime(reminderMinutes), timeZone);
  const next = options.nextCheckIn;
  const endAt = next
    ? wallInstantIso(next.date, next.time, timeZone)
    : new Date(Date.parse(checkOutAt) + times.cleaningBufferMinutes * 60_000).toISOString();
  const gapMinutes = (Date.parse(endAt) - Date.parse(checkOutAt)) / 60_000;
  return {
    checkInAt,
    checkOutAt,
    arrivalGuideAt: new Date(Date.parse(checkInAt) - 24 * 3_600_000).toISOString(),
    checkoutReminderAt,
    cleaningWindow: { startAt: checkOutAt, endAt, shortGap: Boolean(next) && gapMinutes < times.cleaningBufferMinutes },
  };
}

/** "$25" for 2500, "$25.50" for 2550. */
export function formatAddOnPrice(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

export function stayAddOnLabel(kind: StayAddOnKind): string {
  return kind === "early_check_in" ? "Early check-in" : "Late checkout";
}
