import type { PublicRoomOccupancy } from "./public-room-occupancy";
type SnapshotEntry = { spans: PublicRoomOccupancy["spans"]; expiresAt: number };
let snapshot = new Map<string, SnapshotEntry>();
/**
 * When the last landed read stops being trusted (0 = none has landed). The read answers for EVERY room of the
 * houses it covers, so a room with no entry under a live read has no occupancy — while no read at all is an
 * unknown answer, which `publicRoomOccupancyRead` lets a picker refuse to guess at.
 */
let readExpiresAt = 0;
const propertyReadExpiresAt = new Map<string, number>();
export function replacePublicRoomOccupancy(rows: PublicRoomOccupancy[], preservePropertyIds: string[] = []) {
  const preserved = (key: string) => preservePropertyIds.some(id => key.startsWith(`${id}::`));
  const expiresAt = Date.now() + 60_000;
  const next = new Map(rows.filter(row => !preserved(row.roomChoice)).map(row => [row.roomChoice, { spans: row.spans, expiresAt }]));
  for (const [key, entry] of snapshot) if (preserved(key)) next.set(key, entry);
  snapshot = next;
  readExpiresAt = expiresAt;
}
export function replacePublicRoomOccupancyForProperty(propertyId: string, rows: PublicRoomOccupancy[]) {
  const prefix = `${propertyId}::`;
  for (const key of snapshot.keys()) if (key.startsWith(prefix)) snapshot.delete(key);
  const expiresAt = Date.now() + 60_000;
  for (const row of rows) if (row.roomChoice.startsWith(prefix)) snapshot.set(row.roomChoice, { spans: row.spans, expiresAt });
  propertyReadExpiresAt.set(propertyId, expiresAt);
}
/** Forget the loaded answer: a local write or a scope change means nothing here is trusted until the next read. */
export function clearPublicRoomOccupancy() {
  snapshot = new Map();
  readExpiresAt = 0;
  propertyReadExpiresAt.clear();
}
export function readPublicRoomOccupancy(roomChoice: string) {
  const entry = snapshot.get(roomChoice);
  return entry && Date.now() < entry.expiresAt ? entry.spans : undefined;
}
/** True when a read covering this house has landed and not yet lapsed, so its rooms can be judged. */
export function publicRoomOccupancyRead(propertyId: string): boolean {
  const until = Math.max(readExpiresAt, propertyReadExpiresAt.get(propertyId) ?? 0);
  return Date.now() < until;
}
