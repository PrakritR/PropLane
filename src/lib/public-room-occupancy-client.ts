import type { PublicRoomOccupancy } from "./public-room-occupancy";
type SnapshotEntry = { spans: PublicRoomOccupancy["spans"]; expiresAt: number };
let snapshot = new Map<string, SnapshotEntry>();
export function replacePublicRoomOccupancy(rows: PublicRoomOccupancy[], preservePropertyIds: string[] = []) {
  const preserved = (key: string) => preservePropertyIds.some(id => key.startsWith(`${id}::`));
  const expiresAt = Date.now() + 60_000;
  const next = new Map(rows.filter(row => !preserved(row.roomChoice)).map(row => [row.roomChoice, { spans: row.spans, expiresAt }]));
  for (const [key, entry] of snapshot) if (preserved(key)) next.set(key, entry);
  snapshot = next;
}
export function replacePublicRoomOccupancyForProperty(propertyId: string, rows: PublicRoomOccupancy[]) {
  const prefix = `${propertyId}::`;
  for (const key of snapshot.keys()) if (key.startsWith(prefix)) snapshot.delete(key);
  const expiresAt = Date.now() + 60_000;
  for (const row of rows) if (row.roomChoice.startsWith(prefix)) snapshot.set(row.roomChoice, { spans: row.spans, expiresAt });
}
export function readPublicRoomOccupancy(roomChoice: string) {
  const entry = snapshot.get(roomChoice);
  return entry && Date.now() < entry.expiresAt ? entry.spans : undefined;
}
