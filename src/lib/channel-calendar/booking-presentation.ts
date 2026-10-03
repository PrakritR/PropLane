import { isChannelBookingSource, type PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import { getPropertyById } from "@/lib/rental-application/data";
import { roomHeadlineAmount, roomHeadlinePriceLabel } from "@/lib/room-pricing";
import { dateKey } from "@/lib/room-availability-calendar";

export function bookingRoomRate(propertyId: string, roomId: string) {
  const room = getPropertyById(propertyId)?.listingSubmission?.rooms.find((candidate) => candidate.id === roomId);
  return { amount: roomHeadlineAmount(room) ?? undefined, basis: room?.rentBasis ?? "monthly" as const, label: roomHeadlinePriceLabel(room, "—") };
}
export function bookingRateLabel(entry: PropertyBookingEntry): string {
  if (entry.rate == null) return bookingRoomRate(entry.propertyId, entry.roomId).label;
  return `${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(entry.rate)}/${entry.rateBasis === "daily" ? "day" : entry.rateBasis === "weekly" ? "wk" : "mo"}`;
}
export function bookingStatusLabel(entry: PropertyBookingEntry, today = dateKey(new Date())): string {
  if (entry.bookingStatus === "cancelled") return "Cancelled";
  if (!entry.openEnded && entry.end < today) return "Checked out";
  if (entry.source === "hold" || (entry.source === "block" && entry.bookingStatus !== "confirmed")) return "Hold";
  if (entry.start <= today) return "In-house";
  return "Confirmed";
}
export function canCancelBooking(entry: PropertyBookingEntry, today = dateKey(new Date())): boolean {
  return entry.source === "block" && Boolean(entry.blockId) && entry.bookingStatus !== "cancelled" && entry.start > today;
}
/** A reservation read from a channel calendar feed: it can be removed (tombstoned), never edited or cancelled here. */
export function canRemoveChannelStay(entry: PropertyBookingEntry): boolean {
  return isChannelBookingSource(entry.source) && !entry.blockId && Boolean(entry.connectionId) && Boolean(entry.sourceUid);
}
