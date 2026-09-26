/**
 * The one reader and writer of `roomChoice*` values (`property::room` with an
 * optional `::rN` resident slot). A leaf module so storage code that data.ts
 * itself imports can share it without an import cycle.
 */

/** Separates listing property id from submission room id in `roomChoice*` values. */
export const LISTING_ROOM_CHOICE_SEP = "::";
/** Trailing `::r2` on a room-choice value names the 1-based resident slot. */
const LISTING_ROOM_SLOT_SUFFIX = /::r(\d+)$/;

export type ParsedRoomChoice = { propertyId: string; listingRoomId?: string; residentSlot?: number };

export function roomChoiceValue(propertyId: string, listingRoomId: string, residentSlot?: number): string {
  const base = `${propertyId}${LISTING_ROOM_CHOICE_SEP}${listingRoomId}`;
  return Number.isInteger(residentSlot) && (residentSlot as number) >= 1
    ? `${base}${LISTING_ROOM_CHOICE_SEP}r${residentSlot}`
    : base;
}

export function parseRoomChoiceValue(value: string): ParsedRoomChoice {
  const raw = value.trim();
  if (!raw) return { propertyId: "" };
  // `roomChoiceValue` writes a slot only after `property::room`, so `prop::r1`
  // is room "r1" (an imported or legacy id), never property + slot 1.
  const suffix = raw.match(LISTING_ROOM_SLOT_SUFFIX);
  const slotMatch =
    suffix && raw.slice(0, raw.length - suffix[0].length).includes(LISTING_ROOM_CHOICE_SEP) ? suffix : null;
  const parsedSlot = slotMatch ? Number(slotMatch[1]) : undefined;
  const residentSlot =
    Number.isInteger(parsedSlot) && (parsedSlot as number) >= 1 ? parsedSlot : undefined;
  const v = slotMatch ? raw.slice(0, raw.length - slotMatch[0].length) : raw;
  const i = v.indexOf(LISTING_ROOM_CHOICE_SEP);
  if (i === -1) {
    return residentSlot ? { propertyId: v, residentSlot } : { propertyId: v };
  }
  return {
    propertyId: v.slice(0, i),
    listingRoomId: v.slice(i + LISTING_ROOM_CHOICE_SEP.length),
    ...(residentSlot ? { residentSlot } : {}),
  };
}

/** Room identity without a slot suffix — occupancy and public snapshots key on this. */
export function canonicalRoomChoiceValue(value: string): string {
  const { propertyId, listingRoomId } = parseRoomChoiceValue(value);
  if (!propertyId) return "";
  return listingRoomId ? `${propertyId}${LISTING_ROOM_CHOICE_SEP}${listingRoomId}` : propertyId;
}
