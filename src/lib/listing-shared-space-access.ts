/**
 * Who may use a shared space.
 *
 * Everyone is an empty `roomAccessIds` list. A list that names every current
 * room also reads as Everyone and is written back as empty, so a later room
 * still has access — the same rule as fee “all rooms”.
 *
 * There is no “nobody” encoding. Clearing the last room or unticking Everyone
 * while every room is still selected stays Everyone.
 */

export const EVERYONE_ACCESS_VALUE = "__everyone__";

export function sharedSpaceIsEveryone(
  roomAccessIds: readonly string[] | undefined,
  roomIds: readonly string[],
): boolean {
  if (roomIds.length === 0) return true;
  const ids = roomAccessIds ?? [];
  if (ids.length === 0) return true;
  return roomIds.every((id) => ids.includes(id));
}

export function encodeSharedSpaceEveryone(): string[] {
  return [];
}

export function encodeSharedSpaceAccessPick(input: {
  nextSelected: readonly string[];
  roomIds: readonly string[];
  previousAccessIds?: readonly string[];
}): string[] {
  const { roomIds } = input;
  if (roomIds.length === 0) return [];
  const picked = roomIds.filter((id) => input.nextSelected.includes(id));
  const everyoneOn = input.nextSelected.includes(EVERYONE_ACCESS_VALUE);
  const wasEveryone = sharedSpaceIsEveryone(input.previousAccessIds, roomIds);
  if (picked.length === 0 || picked.length >= roomIds.length) return [];
  if (everyoneOn && !wasEveryone) return [];
  return picked;
}

export function sharedSpaceAccessMenuSelected(
  roomAccessIds: readonly string[] | undefined,
  roomIds: readonly string[],
): string[] {
  if (sharedSpaceIsEveryone(roomAccessIds, roomIds)) {
    return [EVERYONE_ACCESS_VALUE, ...roomIds];
  }
  return roomIds.filter((id) => (roomAccessIds ?? []).includes(id));
}

export function sharedSpaceAccessTriggerLabel(
  roomAccessIds: readonly string[] | undefined,
  roomIds: readonly string[],
): string {
  if (sharedSpaceIsEveryone(roomAccessIds, roomIds)) return "Everyone";
  const n = roomIds.filter((id) => (roomAccessIds ?? []).includes(id)).length;
  return n === 1 ? "1 room" : `${n} rooms`;
}

export function sharedSpaceAccessOptions(
  rooms: readonly { id: string; name: string }[],
): { value: string; label: string }[] {
  return [
    { value: EVERYONE_ACCESS_VALUE, label: "Everyone" },
    ...rooms.map((room, i) => ({
      value: room.id,
      label: room.name.trim() || `Room ${i + 1}`,
    })),
  ];
}

/** Keep Everyone when the room set grows or shrinks; drop ids that no longer exist. */
export function retainSharedSpaceAccessAfterRoomsChange(
  roomAccessIds: readonly string[] | undefined,
  previousRoomIds: readonly string[],
  nextRoomIds: readonly string[],
): string[] {
  if (sharedSpaceIsEveryone(roomAccessIds, previousRoomIds)) return [];
  const kept = nextRoomIds.filter((id) => (roomAccessIds ?? []).includes(id));
  if (kept.length === 0 || kept.length >= nextRoomIds.length) return [];
  return kept;
}

export function sharedSpaceAccessNames(
  roomAccessIds: readonly string[] | undefined,
  rooms: readonly { id: string; name?: string }[],
): string {
  const roomIds = rooms.map((room) => room.id);
  if (sharedSpaceIsEveryone(roomAccessIds, roomIds)) return "Everyone";
  return rooms
    .filter((room) => (roomAccessIds ?? []).includes(room.id))
    .map((room) => room.name?.trim())
    .filter((name): name is string => Boolean(name))
    .join(", ");
}
