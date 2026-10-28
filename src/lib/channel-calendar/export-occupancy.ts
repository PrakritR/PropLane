/**
 * Which of a house's rows the iCal export feed publishes as "not available". Pure; the route reads the rows.
 *
 * Two rules keep a feed honest in both directions:
 *  - an approved application that names no room holds NO room (`approvedRowBlocksRoom`): it used to block every
 *    room of the house until the manager chose one, closing nights nobody was staying;
 *  - a stay that CAME FROM a channel is never sent back to that channel (`blockEchoesToDestination`): the channel
 *    already holds it, and re-exporting it turns Airbnb's own reservation into a second "Not available" block that
 *    then outlives the reservation. Other channels still receive it, so a room stays closed everywhere.
 */
import { channelLinkProviderForSource, normalizeChannelLink } from "@/lib/channel-calendar/channel-link";
import { isImportedAirbnbBlock, isImportedBookingBlock } from "@/lib/channel-calendar/property-bookings";
import type { ChannelCalendarProvider } from "@/lib/channel-calendar/types";

/**
 * Does an approved application row (found by property) hold `roomId`? `choice` is the assigned room choice, else
 * the first room choice the applicant picked. A whole-house choice (the property id itself) holds every room; a
 * room choice holds that room only (with or without the `propertyId::` prefix); NO choice holds nothing.
 */
export function approvedRowBlocksRoom(input: { choice: unknown; preferred: unknown; propertyId: string; roomId: string }): boolean {
  const choice = String(input.choice || input.preferred || "").trim();
  if (!choice) return false;
  if (choice === input.propertyId) return true;
  return choice.endsWith(`::${input.roomId}`) || choice === input.roomId;
}

/** The channel a `room_date_block` row came from, or null for a PropLane-native stay (Direct, PadSplit, a closure, ...). */
export function blockChannelProvider(row: Record<string, unknown>): "airbnb" | "booking_com" | null {
  const reason = { reason: typeof row.reason === "string" ? row.reason : "" };
  if (isImportedAirbnbBlock(reason)) return "airbnb";
  if (isImportedBookingBlock(reason)) return "booking_com";
  const details = row.stayDetails && typeof row.stayDetails === "object" && !Array.isArray(row.stayDetails)
    ? (row.stayDetails as Record<string, unknown>)
    : {};
  const linked = normalizeChannelLink(details.channelLink)?.provider;
  if (linked) return linked;
  return channelLinkProviderForSource(details.source);
}

/**
 * Should this block be left out of the feed pasted into `destination`? True only when the block came from that same
 * channel. `null` (a shared or `?channels=all` link) means every channel, which carries everything.
 */
export function blockEchoesToDestination(row: Record<string, unknown>, destination: ChannelCalendarProvider | null): boolean {
  if (!destination) return false;
  const source = blockChannelProvider(row);
  return source !== null && source === destination;
}
