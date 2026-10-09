import { isHostBlockSummary } from "@/lib/channel-calendar/host-block";
import { bookingConflictsFor, isChannelBookingSource, type ChannelBookingSource, type PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";

/** Count imported reservations, not intersecting pairs; a channel stay is never its own conflict. */
export function conflictingChannelStays(entries: readonly PropertyBookingEntry[], propertyId: string, roomId: string, provider: ChannelBookingSource) {
  const local = entries.filter((entry) => !isChannelBookingSource(entry.source));
  return entries.filter((entry) => entry.source === provider && entry.propertyId === propertyId && entry.roomId === roomId && entry.bookingStatus !== "cancelled" && !isHostBlockSummary(entry.summary) && bookingConflictsFor(local, entry).length > 0);
}
