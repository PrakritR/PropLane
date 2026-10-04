/** Sort rank for bedroom floor labels (lower = shown first). */
export function floorLabelSortRank(label: string): number {
  const t = label.trim().toLowerCase();
  if (!t) return 900;
  if (/basement|garden level|lower split/i.test(t)) return 0;
  if (/main split/i.test(t)) return 12;
  if (/(^|\b)(1st|first|main|ground)(\s|\/|$)/i.test(t) && !/(2nd|3rd|4th|second|third|fourth)/i.test(t)) return 10;
  if (/(^|\b)(2nd|second)(\s|\/|$)/i.test(t)) return 20;
  if (/upper split/i.test(t)) return 22;
  if (/(^|\b)(3rd|third)(\s|\/|$)/i.test(t)) return 30;
  if (/(^|\b)(4th|fourth|higher)(\s|\/|$)/i.test(t)) return 40;
  if (/loft|attic|top/i.test(t)) return 50;
  if (/outdoor|detached/i.test(t)) return 60;
  return 500;
}

export function compareFloorLabels(a: string, b: string): number {
  const ra = floorLabelSortRank(a);
  const rb = floorLabelSortRank(b);
  if (ra !== rb) return ra - rb;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function roomNameSortKey(name: string): number {
  const m = name.match(/\d+/);
  return m ? Number(m[0]) : Number.MAX_SAFE_INTEGER;
}

/** Property-wide room media browser: numeric room name first, then floor label. */
export function compareListingRoomMediaEntries(
  a: { room: { name: string }; floorLabel: string },
  b: { room: { name: string }; floorLabel: string },
): number {
  const na = roomNameSortKey(a.room.name.trim());
  const nb = roomNameSortKey(b.room.name.trim());
  if (na !== nb) return na - nb;
  const byFloor = compareFloorLabels(a.floorLabel, b.floorLabel);
  if (byFloor !== 0) return byFloor;
  return a.room.name.localeCompare(b.room.name, undefined, { numeric: true, sensitivity: "base" });
}

export function compareRoomsByFloorThenName(
  a: { floor: string; name: string },
  b: { floor: string; name: string },
): number {
  const byFloor = compareFloorLabels(a.floor, b.floor);
  if (byFloor !== 0) return byFloor;
  const na = roomNameSortKey(a.name.trim());
  const nb = roomNameSortKey(b.name.trim());
  if (na !== nb) return na - nb;
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
}

/** Original indices sorted for display (floor ascending, then room number/name). */
export function sortRoomIndicesByFloor<T extends { floor: string; name: string }>(rooms: readonly T[]): number[] {
  return rooms
    .map((room, index) => ({ room, index }))
    .sort((a, b) => compareRoomsByFloorThenName(a.room, b.room))
    .map(({ index }) => index);
}

export function sortUniqueFloorLabels(labels: readonly string[]): string[] {
  return [...new Set(labels.map((l) => l.trim()).filter(Boolean))].sort(compareFloorLabels);
}

/**
 * Original indices in the LISTING's own room order - the order House details and Pricing list. A property
 * record's rooms tabs use this, not the floor sort above, so "Room 1, 2, 3, 4, 5" reads the same on every
 * tab (the floor sort put Room 5 first on a house whose Room 5 is on the lowest floor).
 */
export function roomIndicesInListingOrder<T>(rooms: readonly T[]): number[] {
  return rooms.map((_, index) => index);
}
