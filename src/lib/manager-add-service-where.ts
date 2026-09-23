import { getRoomChoiceLabel, getRoomOptionsForProperty } from "@/lib/rental-application/data";

function roomName(value: string, fallback: string): string {
  return getRoomChoiceLabel(value).split(" · ")[0]?.trim() || fallback.split(" · ")[0]?.trim() || fallback;
}

/**
 * Empty rooms a manager can attach to a service. `getRoomOptionsForProperty`
 * already drops occupied beds (`isRoomChoiceAvailable`). The resident's current
 * room is kept even when full so a locked-from-row log can still name it.
 */
export function emptyRoomsForManagerService(
  propertyId: string,
  keepChoice?: string,
): { value: string; label: string }[] {
  const rooms = getRoomOptionsForProperty(propertyId).map((room) => ({
    value: room.value,
    label: roomName(room.value, room.label),
  }));
  const keep = keepChoice?.trim();
  if (keep && !rooms.some((room) => room.value === keep)) {
    rooms.unshift({ value: keep, label: roomName(keep, keep) });
  }
  return rooms;
}

export function roomLabelForManagerService(roomChoice: string | undefined): string {
  const raw = roomChoice?.trim();
  if (!raw) return "";
  return roomName(raw, raw);
}
