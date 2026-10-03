import { getRoomOptionsForProperty, isEntireHomeProperty, parseRoomChoiceValue } from "@/lib/rental-application/data";

export type ChannelCalendarUnit = { id: string; label: string };

/**
 * The things a channel calendar links to on one house: each room, or - for an entire-home
 * listing - the house itself, keyed by its property id (the id a whole-home stay already uses).
 */
export function channelCalendarUnits(propertyId: string, houseLabel: string): ChannelCalendarUnit[] {
  if (!propertyId) return [];
  if (isEntireHomeProperty(propertyId)) return [{ id: propertyId, label: houseLabel || propertyId }];
  return getRoomOptionsForProperty(propertyId, { includeUnavailable: true })
    .map((r) => ({ id: parseRoomChoiceValue(r.value).listingRoomId ?? "", label: r.label }))
    .filter((r) => r.id);
}
