import { channelCalendarProviderLabel } from "@/lib/channel-calendar/airbnb-url";
import type { ChannelCalendarProvider, ManagerChannelBookingProperty } from "@/lib/channel-calendar/types";

/** One room linked to a channel, with the two "last checked" facts. */
export type ChannelRoomLink = {
  propertyId: string;
  roomId: string;
  provider: ChannelCalendarProvider;
  connectionId: string;
  /** PropLane last read the channel's calendar. */
  lastSyncedAt: string | null;
  /** The channel last read PropLane's export feed. */
  exportLastFetchedAt: string | null;
};

/** Rooms that are really linked: a connection with an import URL pasted, not a bare export token. */
export function channelLinksFromBookings(properties: readonly ManagerChannelBookingProperty[]): ChannelRoomLink[] {
  return properties.flatMap((property) =>
    property.rooms
      .filter((room) => room.hasImportUrl)
      .map((room) => ({
        propertyId: property.propertyId,
        roomId: room.roomId,
        provider: room.provider,
        connectionId: room.connectionId,
        lastSyncedAt: room.lastSyncedAt,
        exportLastFetchedAt: room.exportLastFetchedAt ?? null,
      })),
  );
}

/** The Airbnb link for a room, if any. An entire-home listing links under its "" room id. */
export function airbnbLinkForRoom(links: readonly ChannelRoomLink[], propertyId: string, roomId: string): ChannelRoomLink | null {
  return links.find((link) => link.provider === "airbnb" && link.propertyId === propertyId && link.roomId === roomId) ?? null;
}

/** "5:42 PM" today, "Oct 8, 5:42 PM" otherwise; "" for nothing recorded. */
export function formatCheckedAt(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const time = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (at.toDateString() === now.toDateString()) return time;
  return `${at.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${time}`;
}

/** The two facts per linked room, as label/value rows. A side that was never checked says so. */
export function channelCheckFacts(
  link: { lastSyncedAt: string | null; exportLastFetchedAt?: string | null },
  now: Date = new Date(),
  provider: ChannelCalendarProvider = "airbnb",
): Array<{ label: string; value: string }> {
  const channel = channelCalendarProviderLabel(provider);
  return [
    { label: `${channel} checked PropLane`, value: formatCheckedAt(link.exportLastFetchedAt ?? null, now) || "Not yet" },
    { label: `PropLane checked ${channel}`, value: formatCheckedAt(link.lastSyncedAt, now) || "Not yet" },
  ];
}
