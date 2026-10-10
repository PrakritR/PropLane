import { isChannelBookingSource, type PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import { getPropertyById } from "@/lib/rental-application/data";
import { roomHeadlineAmount, roomHeadlinePriceLabel } from "@/lib/room-pricing";
import { dateKey } from "@/lib/room-availability-calendar";

export function bookingRoomRate(propertyId: string, roomId: string) {
  const room = getPropertyById(propertyId)?.listingSubmission?.rooms.find((candidate) => candidate.id === roomId);
  return { amount: roomHeadlineAmount(room) ?? undefined, basis: room?.rentBasis ?? "monthly" as const, label: roomHeadlinePriceLabel(room, "—") };
}
export function bookingRateLabel(entry: PropertyBookingEntry): string {
  // A resident's own rent wins over the room listing's rate (and over a block's rate: the resident is who pays).
  if (entry.monthlyRent != null) return `${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(entry.monthlyRent)}/mo`;
  if (entry.rate == null) return bookingRoomRate(entry.propertyId, entry.roomId).label;
  return `${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(entry.rate)}/${entry.rateBasis === "daily" ? "day" : entry.rateBasis === "weekly" ? "wk" : "mo"}`;
}
export function bookingStatusLabel(entry: PropertyBookingEntry, today = dateKey(new Date())): string {
  if (entry.bookingStatus === "cancelled") return "Cancelled";
  if (!entry.openEnded && entry.end < today) return "Checked out";
  // An approved resident who has moved in is living there, not holding the room.
  if (entry.source === "hold" && entry.applicationId && entry.start <= today) return "In-house";
  if (entry.source === "hold" || (entry.source === "block" && entry.bookingStatus !== "confirmed")) return "Hold";
  if (entry.start <= today) return "In-house";
  return "Confirmed";
}
/**
 * A manager block can be cancelled until its last night has passed - including one that has already
 * started (ending a reservation early frees the rest of the room, and the export feed drops it).
 * Residents (a hold or a lease) are never cancelled from here; their dates belong to the lease.
 */
export function canCancelBooking(entry: PropertyBookingEntry, today = dateKey(new Date())): boolean {
  return entry.source === "block" && Boolean(entry.blockId) && entry.bookingStatus !== "cancelled" && (entry.openEnded === true || entry.end >= today);
}
/** A block with nobody attached: dates the manager marked reserved. Removing it is "Remove", not "Cancel booking". */
export function isReservedBlock(entry: Pick<PropertyBookingEntry, "source" | "residentName" | "residentEmail" | "residentPhone">): boolean {
  return entry.source === "block" && !entry.residentName?.trim() && !entry.residentEmail?.trim() && !entry.residentPhone?.trim();
}
/** The destructive action's label in the row/record ⋯: "Remove" for marked-reserved dates, else "Cancel booking". */
export function bookingCancelLabel(entry: Parameters<typeof isReservedBlock>[0]): string {
  return isReservedBlock(entry) ? "Remove" : "Cancel booking";
}
/** A reservation read from a channel calendar feed: it can be removed (tombstoned), never edited or cancelled here. */
export function canRemoveChannelStay(entry: PropertyBookingEntry): boolean {
  return isChannelBookingSource(entry.source) && !entry.blockId && Boolean(entry.connectionId) && Boolean(entry.sourceUid);
}
