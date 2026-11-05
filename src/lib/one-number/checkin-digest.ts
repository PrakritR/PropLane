import { bookingSourceLabel } from "@/lib/channel-calendar/bookings-ui";
import { isChannelBookingSource, type PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import { isAvailabilityBlockRow } from "@/lib/occupancy/snapshot";
import { checkinDigestLine, guestFirstName, nextDayKey, type DigestMove } from "@/lib/one-number/ops-alert-lines";

/**
 * Who checks in and out of each house on one day, read off the Bookings entries (the same
 * `PropertyBookingEntry` rows the Bookings calendar draws, so Airbnb / Booking.com / PadSplit calendar
 * imports, PropLane leases, guest stays and named room blocks are all counted exactly as Bookings counts
 * them). Pure: no database, no clock.
 */

export type HouseMoves = { propertyId: string; house: string; checkIns: DigestMove[]; checkOuts: DigestMove[] };

/** A stay a person is actually coming to or leaving: not a closure, a cancellation, or a room still only held. */
export function isDigestStay(entry: PropertyBookingEntry): boolean {
  if (entry.bookingStatus === "cancelled" || entry.bookingStatus === "hold") return false;
  if (entry.source === "hold" || entry.blockKind === "closed") return false;
  return !isAvailabilityBlockRow(entry);
}

function moveOf(entry: PropertyBookingEntry, time: string | undefined): DigestMove {
  return {
    room: entry.roomLabel?.trim() || "Whole home",
    guest: guestFirstName(entry.residentName || entry.guestName || entry.summary),
    channel: isChannelBookingSource(entry.source) ? bookingSourceLabel(entry.source, entry.channelLabel) : null,
    time: time ?? null,
  };
}

function roomOrder(a: DigestMove, b: DigestMove): number {
  return a.room.localeCompare(b.room, "en", { numeric: true }) || a.guest.localeCompare(b.guest);
}

/**
 * Each house's check-ins (`start` is today) and check-outs (`end` is the LAST night, so the guest leaves the
 * day after; an open-ended stay never checks out). Houses with neither are left out. Entries must already
 * carry resolved times (`withResolvedStayTimes`), else the line simply omits the time.
 */
export function movesByHouse(entries: readonly PropertyBookingEntry[], dayKey: string): HouseMoves[] {
  const houses = new Map<string, HouseMoves>();
  const house = (entry: PropertyBookingEntry) => {
    let found = houses.get(entry.propertyId);
    if (!found) {
      found = { propertyId: entry.propertyId, house: entry.propertyLabel?.trim() || entry.propertyId, checkIns: [], checkOuts: [] };
      houses.set(entry.propertyId, found);
    }
    return found;
  };
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!isDigestStay(entry)) continue;
    const comingIn = entry.start === dayKey;
    const leaving = !entry.openEnded && nextDayKey(entry.end) === dayKey;
    if (!comingIn && !leaving) continue;
    // The same reservation can arrive from two sources (a channel import and the resident filed for it).
    const key = `${entry.propertyId}|${entry.roomId}|${entry.start}|${entry.end}|${comingIn ? "in" : "out"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (comingIn) house(entry).checkIns.push(moveOf(entry, entry.checkInTime));
    if (leaving) house(entry).checkOuts.push(moveOf(entry, entry.checkOutTime));
  }
  return [...houses.values()]
    .map((h) => ({ ...h, checkIns: h.checkIns.sort(roomOrder), checkOuts: h.checkOuts.sort(roomOrder) }))
    .sort((a, b) => a.house.localeCompare(b.house, "en", { numeric: true }));
}

/** The text for each house that has something today, keyed by property id. */
export function digestLinesByHouse(entries: readonly PropertyBookingEntry[], dayKey: string): Array<{ propertyId: string; text: string }> {
  return movesByHouse(entries, dayKey)
    .map((h) => ({ propertyId: h.propertyId, text: checkinDigestLine(h.house, h.checkIns, h.checkOuts) }))
    .filter((line) => line.text);
}
