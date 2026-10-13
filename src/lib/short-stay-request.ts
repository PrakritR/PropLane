/**
 * The pure half of the public "Request to book" flow (a short stay like Airbnb's): the date rules, the
 * nightly rate, the live total and the per-room "free for these nights?" answer. The listing price card,
 * the rooms list and `POST /api/public/short-stay-request` all read these, so what a guest sees and what
 * the server accepts cannot drift. Payments are NOT here: a request creates a manager hold, nothing is
 * charged (the old hold-and-pay path stays retired).
 */
import type { PublicRoomOccupancy } from "@/lib/public-room-occupancy";
import { evaluateRoomRange, addRangeDays, normalizeRangeDay, rangeDaysBetween } from "@/lib/room-availability-range";
import { roomDailyRentPrice, type RoomPricingLike } from "@/lib/room-pricing";
import { normalizeRoomOccupancyCapacity } from "@/lib/rental-application/room-occupancy";
import { shortStayRangeHasRoom } from "@/lib/short-stay-availability";
import { shortTermNightlyRate } from "@/lib/short-term-stay-pricing";

export const SHORT_STAY_MAX_NIGHTS = 28;
export const SHORT_STAY_MAX_DAYS_AHEAD = 180;
export const SHORT_STAY_MAX_GUESTS = 20;

export type ShortStayRoomLike = RoomPricingLike & { occupancyCapacity?: number | null };

export type ShortStaySubmissionLike = {
  shortTermRentalsAllowed?: boolean;
  shortTermDailyCost?: string;
  rooms?: readonly (ShortStayRoomLike & { id?: string })[];
};

/** The nightly rate one room is booked at: its own short-term rate, its daily basis, then the listing's nightly cost. */
export function shortStayRoomNightly(room: ShortStayRoomLike | null | undefined, listingDailyCost?: string | null): number {
  return (
    shortTermNightlyRate(room?.shortTermRent) ||
    roomDailyRentPrice(room) ||
    shortTermNightlyRate(listingDailyCost) ||
    0
  );
}

/** True when the card should offer dates: the listing allows short stays, or a room is priced by the day. */
export function listingOffersShortStay(sub: ShortStaySubmissionLike | null | undefined): boolean {
  if (!sub) return false;
  if (sub.shortTermRentalsAllowed) return true;
  return (sub.rooms ?? []).some((room) => roomDailyRentPrice(room) !== undefined);
}

/** The lowest nightly rate across the listing's rooms (0 when none carries one). */
export function listingShortStayNightlyFrom(sub: ShortStaySubmissionLike | null | undefined): number {
  if (!sub) return 0;
  const rooms = sub.rooms ?? [];
  const rates = (rooms.length ? rooms : [undefined]).map((room) => shortStayRoomNightly(room, sub.shortTermDailyCost)).filter((n) => n > 0);
  return rates.length ? Math.min(...rates) : 0;
}

/** Whole nights between two YYYY-MM-DD dates (check-out exclusive), or null when either is not a real date. */
export function shortStayNights(checkIn: string, checkOut: string): number | null {
  const a = normalizeRangeDay(checkIn);
  const b = normalizeRangeDay(checkOut);
  if (!a || !b) return null;
  return rangeDaysBetween(a, b);
}

export function shortStayTotal(nightly: number, nights: number): number {
  return Math.round(nightly * nights * 100) / 100;
}

export function formatShortStayMoney(amount: number): string {
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(amount) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

export type ShortStayDateCheck =
  | { ok: true; checkIn: string; checkOut: string; nights: number }
  | { ok: false; error: string };

/** Real dates, check-in today or later and within 180 days, 1 to 28 nights. `today` is a Pacific YYYY-MM-DD. */
export function validateShortStayDates(checkIn: unknown, checkOut: unknown, today: string): ShortStayDateCheck {
  const a = normalizeRangeDay(checkIn);
  const b = normalizeRangeDay(checkOut);
  if (!a || !b) return { ok: false, error: "Choose a check-in and check-out date." };
  if (a < today) return { ok: false, error: "Check-in can't be in the past." };
  if (a > addRangeDays(today, SHORT_STAY_MAX_DAYS_AHEAD)) {
    return { ok: false, error: `Check-in must be within ${SHORT_STAY_MAX_DAYS_AHEAD} days.` };
  }
  const nights = rangeDaysBetween(a, b);
  if (nights < 1) return { ok: false, error: "Check-out must be after check-in." };
  if (nights > SHORT_STAY_MAX_NIGHTS) return { ok: false, error: `Stays are ${SHORT_STAY_MAX_NIGHTS} nights at most.` };
  return { ok: true, checkIn: a, checkOut: b, nights };
}

/** "Oct 20" from a YYYY-MM-DD. */
export function shortStayDayLabel(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** "Oct 20 – Oct 24" for a check-in and (exclusive) check-out. */
export function shortStayRangeLabel(checkIn: string, checkOut: string): string {
  return `${shortStayDayLabel(checkIn)} – ${shortStayDayLabel(checkOut)}`;
}

export type ShortStayRoomVerdict =
  | { free: true }
  | { free: false; label: string; freeFrom?: string };

/**
 * Is one room free for [checkIn, checkOut) and, when not, the plain line the rooms list prints:
 * "Booked Oct 21 – Oct 22 · free from Oct 25". Anonymous capacity spans only - never who is staying.
 */
export function shortStayRoomVerdict(input: {
  spans: PublicRoomOccupancy["spans"];
  capacity: unknown;
  availableFrom?: string | null;
  checkIn: string;
  checkOut: string;
}): ShortStayRoomVerdict {
  const verdict = evaluateRoomRange({
    spans: input.spans,
    capacity: input.capacity,
    availableFrom: input.availableFrom,
    moveIn: input.checkIn,
    moveOut: input.checkOut,
  });
  const capacity = normalizeRoomOccupancyCapacity(input.capacity);
  if (verdict.available && shortStayRangeHasRoom(input.spans, capacity, input.checkIn, input.checkOut)) return { free: true };
  const conflict = verdict.firstConflict;
  const booked = conflict
    ? conflict.end
      ? `Booked ${shortStayDayLabel(conflict.start)}${conflict.end !== conflict.start ? ` – ${shortStayDayLabel(addRangeDays(conflict.end, 1))}` : ""}`
      : `Booked from ${shortStayDayLabel(conflict.start)}`
    : "Booked";
  const freeFrom = verdict.nextAvailableFrom;
  return { free: false, label: freeFrom ? `${booked} · free from ${shortStayDayLabel(freeFrom)}` : booked, ...(freeFrom ? { freeFrom } : {}) };
}

/** "Oct 20–24" (same month) or "Oct 30 – Nov 2" for the guest's confirmation text. */
export function shortStayCompactRange(checkIn: string, checkOut: string): string {
  const a = new Date(`${checkIn}T12:00:00Z`);
  const b = new Date(`${checkOut}T12:00:00Z`);
  if (a.getUTCMonth() === b.getUTCMonth() && a.getUTCFullYear() === b.getUTCFullYear()) {
    return `${shortStayDayLabel(checkIn)}–${b.getUTCDate()}`;
  }
  return shortStayRangeLabel(checkIn, checkOut);
}

/** "Got it, Priya — Room 3 at 5257 Brooklyn Ave, Oct 20–24 ($220). Ambika will confirm shortly. Reply here with questions." */
export function shortStayRequestAckText(input: {
  guestName: string;
  roomLabel: string;
  propertyLabel: string;
  checkIn: string;
  checkOut: string;
  total: number;
  ownerFirstName: string;
}): string {
  const first = input.guestName.trim().split(/\s+/)[0] || "there";
  const owner = input.ownerFirstName.trim() || "Your host";
  return `Got it, ${first} — ${input.roomLabel} at ${input.propertyLabel}, ${shortStayCompactRange(input.checkIn, input.checkOut)} (${formatShortStayMoney(input.total)}). ${owner} will confirm shortly. Reply here with questions.`;
}
