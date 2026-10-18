/**
 * The turnover cleaning window (bookings-times-1018): from one guest's real checkout to the next
 * guest's real check-in on the same room, read off `bookingTimeline`. Pure, no I/O, so the sweep
 * that opens a cleaning run and the re-time after a paid early check-in / late checkout read the
 * same answer.
 */
import {
  bookingTimeline,
  formatStayMoment,
  formatStayTime,
  resolveStayTimes,
  type PropertyStayTimes,
} from "@/lib/bookings/stay-times";

/** What a turnover needs to know about a stay: its dates and the times it carries of its own (if any). */
export type WindowStay = {
  propertyId: string | null;
  roomId?: string;
  checkInKey: string;
  checkOutKey: string | null;
  checkInTime?: string | null;
  checkOutTime?: string | null;
};

/** The earliest stay at the same house and room checking in on or after this stay's checkout date. */
export function nextStayAfter<T extends WindowStay>(stays: readonly T[], stay: T): T | null {
  if (!stay.checkOutKey) return null;
  const out = stay.checkOutKey;
  const after = stays
    .filter(
      (other) =>
        other !== stay &&
        other.propertyId === stay.propertyId &&
        (other.roomId ?? "") === (stay.roomId ?? "") &&
        other.checkInKey >= out,
    )
    .sort((a, b) => a.checkInKey.localeCompare(b.checkInKey) || String(a.checkInTime ?? "").localeCompare(String(b.checkInTime ?? "")));
  return after[0] ?? null;
}

function gapLabel(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  if (total < 60) return `${total} min`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

export type TurnoverWindow = {
  /** "Oct 19, 11:00 am – 3:00 pm" with a next guest, else "after checkout Oct 19, 11:00 am". */
  whenLabel: string;
  /** "check-in 3:00 pm" (with the date when it is not the checkout day); absent with no next guest. */
  deadlineLabel?: string;
  /** The next guest's real check-in instant; absent with no next guest. */
  deadlineIso?: string;
  /** The next check-in is closer than the property's cleaning buffer. */
  shortGap: boolean;
  /** Shown to the vendor when the gap is short. */
  note?: string;
  startAt: string;
  endAt: string;
};

/**
 * The window for the turnover after `stay`'s checkout. `next` is the next stay on the room (or
 * null); stays carry their own times when they have them, else the property's defaults.
 */
export function turnoverWindow(
  stay: WindowStay & { checkOutKey: string },
  next: WindowStay | null,
  clock: { times: PropertyStayTimes; timeZone: string },
): TurnoverWindow {
  const own = resolveStayTimes(stay, clock.times);
  const nextTimes = next ? resolveStayTimes(next, clock.times) : null;
  const timeline = bookingTimeline(
    { checkIn: stay.checkInKey, checkOut: stay.checkOutKey, checkInTime: own.checkInTime, checkOutTime: own.checkOutTime },
    {
      times: clock.times,
      timeZone: clock.timeZone,
      nextCheckIn: next && nextTimes ? { date: next.checkInKey, time: nextTimes.checkInTime } : null,
    },
  );
  const { startAt, endAt, shortGap } = timeline.cleaningWindow;
  const out = formatStayMoment(stay.checkOutKey, own.checkOutTime);
  if (!next || !nextTimes) {
    return { whenLabel: `after checkout ${out}`, shortGap: false, startAt, endAt };
  }
  const sameDay = next.checkInKey === stay.checkOutKey;
  const end = sameDay ? formatStayTime(nextTimes.checkInTime) : formatStayMoment(next.checkInKey, nextTimes.checkInTime);
  const gapMinutes = (Date.parse(endAt) - Date.parse(startAt)) / 60_000;
  return {
    whenLabel: `${out} – ${end}`,
    deadlineLabel: `check-in ${end}`,
    deadlineIso: endAt,
    shortGap,
    ...(shortGap ? { note: `Tight turnover: the next guest checks in ${gapLabel(gapMinutes)} after checkout.` } : {}),
    startAt,
    endAt,
  };
}
