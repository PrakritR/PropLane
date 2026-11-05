/**
 * The one shape of a tour pick that travels through an account step.
 *
 * A signed-out prospect picks a room, day and time on the public tour page; the account is asked for only at
 * "Your details". The pick rides the sign-in / sign-up `next` as `slot` + `room`, and
 * `/resident/tour/schedule` reads it back and preselects it. Nothing here is trusted: the slot is a
 * prefill, and booking re-checks it on the server.
 */

/** `YYYY-MM-DD:slotIndex` - Pacific wall time, the same key the availability route publishes. */
const SLOT_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2}):(\d{1,3})$/;

export const TOUR_ROOM_ANY_PARAM = "any";

export type ParsedTourSlotKey = {
  slotKey: string;
  dateStr: string;
  year: number;
  /** Zero-based, like `Date#getMonth`. */
  month: number;
  day: number;
  slotIndex: number;
};

export function parseTourSlotKey(raw: string | null | undefined): ParsedTourSlotKey | null {
  const match = SLOT_KEY_PATTERN.exec((raw ?? "").trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const slotIndex = Number(match[4]);
  const probe = new Date(year, month, day, 12, 0, 0, 0);
  if (probe.getFullYear() !== year || probe.getMonth() !== month || probe.getDate() !== day) return null;
  return { slotKey: `${match[1]}-${match[2]}-${match[3]}:${slotIndex}`, dateStr: `${match[1]}-${match[2]}-${match[3]}`, year, month, day, slotIndex };
}

/** `<propertyId>::<roomId>` -> `roomId`; the "not sure yet" sentinel and a single-room key -> `any`. */
export function tourRoomParamForKey(propertyId: string, roomKey: string | null | undefined): string {
  const prefix = `${propertyId}::`;
  if (roomKey && roomKey.startsWith(prefix)) {
    const id = roomKey.slice(prefix.length).trim();
    if (id) return id;
  }
  return TOUR_ROOM_ANY_PARAM;
}

/** The resident-portal schedule page, with the pick preselected. */
export function tourSchedulePath(input: {
  propertyId: string;
  slotKey?: string | null;
  roomParam?: string | null;
}): string {
  const q = new URLSearchParams({ propertyId: input.propertyId.trim() });
  const slot = parseTourSlotKey(input.slotKey);
  if (slot) {
    q.set("slot", slot.slotKey);
    q.set("room", input.roomParam?.trim() || TOUR_ROOM_ANY_PARAM);
  }
  return `/resident/tour/schedule?${q.toString()}`;
}
