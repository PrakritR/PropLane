/**
 * Channel guests as Residents-list rows.
 *
 * A guest who booked a house through Airbnb, Booking.com, Vrbo or another calendar is somebody the
 * manager has under their roof, so the Residents list shows them beside the long-term residents.
 * They are DERIVED from the booking rows: no login, no application, nothing written. The row opens
 * the booking record, where the stay's own facts, money and messages live.
 *
 * Pure, so the rules (who counts, what a row is called, what it opens) are unit-tested without a store.
 */

import { bookingEntryGuestLabel } from "@/lib/channel-calendar/booking-guest-label";
import { addDaysToDateKey, bookingEntryKey, bookingSourceLabel } from "@/lib/channel-calendar/bookings-ui";
import { isChannelBookingSource, type PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import { isHostBlockSummary } from "@/lib/channel-calendar/host-block";
import { bookingRecordHref } from "@/lib/portal-detail-routes";
import { isPersonOccupant } from "@/lib/occupancy/snapshot";

/** What makes a Residents row a channel guest instead of a resident record. */
export type ChannelGuestFacts = {
  /** The booking record this row opens. */
  href: string;
  /** "Airbnb", "Booking.com", "Vrbo", or the site the manager named for an "Other calendar". */
  sourceLabel: string;
  /** First night, YYYY-MM-DD. */
  start: string;
  /** Check-out day (exclusive last night + 1), YYYY-MM-DD, so the row reads like the booking record. */
  checkOut: string;
};

export type ChannelGuestRow = {
  id: string;
  name: string;
  email: string;
  propertyId: string;
  propertyLabel: string;
  roomLabel: string;
  leaseStart: string;
  channelStay: ChannelGuestFacts;
};

/** `${connectionId}\0${sourceUid}` of every reservation a resident row already stands in for. */
export function channelStayCoverageKey(connectionId: string, sourceUid: string): string {
  return `${connectionId}\0${sourceUid}`;
}

/**
 * The name a guest row carries: the guest name on the stay (typed, or read off Airbnb's email), else
 * a real name the feed carried, else "<Channel> guest" (the reservation code is on the record, not in
 * the list). Never "Reserved" or "CLOSED - Not available".
 */
export function channelGuestName(entry: PropertyBookingEntry): string {
  const label = bookingEntryGuestLabel(entry).trim();
  const generic =
    !label ||
    /^booked \(/i.test(label) ||
    /^reserved$/i.test(label) ||
    // A stay a manager imported into the calendar is filed under its channel's own name ("Airbnb", "Booking").
    /^(airbnb|booking(\.com)?|vrbo)$/i.test(label) ||
    /not available|^closed\b/i.test(label) ||
    isHostBlockSummary(label);
  if (!generic) return label;
  return `${bookingSourceLabel(entry.source, entry.channelLabel)} guest`;
}

/**
 * Residents-list rows for the channel stays that are happening or about to: in the house tonight or
 * checking in later, never a past stay, a cancelled one, a host block, or one a resident row already
 * stands in for (the sync files a placeholder resident for an iCal reservation; two rows for one
 * guest would be wrong).
 */
export function channelGuestRows(
  entries: readonly PropertyBookingEntry[],
  opts: {
    /** Today, YYYY-MM-DD in the property's calendar. */
    today: string;
    /** Reservations a resident row already stands in for (`channelStayCoverageKey`). */
    coveredByResident?: ReadonlySet<string>;
    /** `${propertyId}\0${roomId}\0${start}\0${end}` of resident stays, so a hand-added Airbnb resident is not repeated. */
    residentStayShapes?: ReadonlySet<string>;
    /** Houses the manager is looking at; absent = all. */
    propertyIds?: ReadonlySet<string>;
    basePath: string;
  },
): ChannelGuestRow[] {
  const seen = new Set<string>();
  const out: ChannelGuestRow[] = [];
  for (const entry of entries) {
    if (!isChannelBookingSource(entry.source)) continue;
    if (entry.bookingStatus === "cancelled") continue;
    if (!isPersonOccupant(entry)) continue;
    if (opts.propertyIds && !opts.propertyIds.has(entry.propertyId)) continue;
    // `end` is the last NIGHT: a stay that checked out today or earlier is history.
    if (!entry.openEnded && entry.end < opts.today) continue;
    if (
      entry.connectionId &&
      entry.sourceUid &&
      opts.coveredByResident?.has(channelStayCoverageKey(entry.connectionId, entry.sourceUid))
    ) {
      continue;
    }
    if (opts.residentStayShapes?.has(`${entry.propertyId}\0${entry.roomId}\0${entry.start}\0${entry.end}`)) continue;
    const key = bookingEntryKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: `channel-stay:${key}`,
      name: channelGuestName(entry),
      email: "",
      propertyId: entry.propertyId,
      propertyLabel: entry.propertyLabel,
      roomLabel: entry.roomLabel,
      leaseStart: entry.start,
      channelStay: {
        href: bookingRecordHref(opts.basePath, key),
        sourceLabel: bookingSourceLabel(entry.source, entry.channelLabel),
        start: entry.start,
        checkOut: entry.openEnded ? "" : addDaysToDateKey(entry.end, 1),
      },
    });
  }
  return out.sort(
    (a, b) =>
      a.channelStay.start.localeCompare(b.channelStay.start) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
}
