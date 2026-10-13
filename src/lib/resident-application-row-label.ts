import { placeNameOrEmpty } from "@/lib/room-display-label";
import { stripPropertyRoomCountSuffix } from "@/lib/portal-mobile-preview";

/**
 * The name a resident reads on an application row: the property, never a raw id
 * and never a bare number (a stored "2" is a room count that lost its house, not a
 * name). Falls back to the catalog title for the row's property, then "Application".
 */
export function usableApplicationPropertyName(value: string | null | undefined): string {
  const stored = placeNameOrEmpty(stripPropertyRoomCountSuffix(value ?? ""));
  // A bare number is a room count that lost its house; "PROPLANE-FCD65B78" is the application's own id.
  return /^\d+$/.test(stored) || /^(proplane|axis)-[0-9a-z]{4,}$/i.test(stored) ? "" : stored;
}

export function residentApplicationRowTitle(
  row: { property?: string | null },
  catalogTitle?: string | null,
): string {
  const usable = usableApplicationPropertyName(row.property);
  if (usable) return usable;
  const catalog = placeNameOrEmpty(stripPropertyRoomCountSuffix(catalogTitle ?? ""));
  return catalog || "Application";
}

/** "Room 2 · Long-term" — the room and the term, never the application's own id. */
export function residentApplicationRowPlaceLine(room: string | null | undefined, termLabel: string | null | undefined): string {
  const roomPart = room && room !== "—" ? (/^room\b/i.test(room) ? room : `Room ${room}`) : "";
  return [roomPart, termLabel].filter((part) => Boolean(part && part.trim())).join(" · ");
}
