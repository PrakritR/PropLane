import { bookingConflictsFor, type PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";

/** Count imported reservations, not intersecting pairs; a channel stay is never its own conflict. */
export function conflictingChannelStays(entries: readonly PropertyBookingEntry[], propertyId: string, roomId: string, provider: "airbnb" | "booking_com") {
  const local = entries.filter((entry) => entry.source !== "airbnb" && entry.source !== "booking_com");
  return entries.filter((entry) => entry.source === provider && entry.propertyId === propertyId && entry.roomId === roomId && entry.bookingStatus !== "cancelled" && bookingConflictsFor(local, entry).length > 0);
}
