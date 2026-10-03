import { getPropertyById, getRoomOptionsForProperty, isEntireHomeProperty, parseRoomChoiceValue } from "@/lib/rental-application/data";

/** `label` is the picker text (may carry floor and rent); `name` is the room's own name alone. */
export type ChannelCalendarUnit = { id: string; label: string; name: string };

/**
 * The things a channel calendar links to on one house: each room, or - for an entire-home
 * listing - the house itself, keyed by its property id (the id a whole-home stay already uses).
 */
export function channelCalendarUnits(propertyId: string, houseLabel: string): ChannelCalendarUnit[] {
  if (!propertyId) return [];
  if (isEntireHomeProperty(propertyId)) return [{ id: propertyId, label: houseLabel || propertyId, name: "Whole house" }];
  return getRoomOptionsForProperty(propertyId, { includeUnavailable: true })
    .map((r) => {
      const id = parseRoomChoiceValue(r.value).listingRoomId ?? "";
      const own = getPropertyById(propertyId)?.listingSubmission?.rooms?.find((room) => room.id === id)?.name?.trim();
      return { id, label: r.label, name: own || r.label.split(" · ")[0]!.trim() };
    })
    .filter((r) => r.id);
}
