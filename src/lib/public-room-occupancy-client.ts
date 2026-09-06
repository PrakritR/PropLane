import type { PublicRoomOccupancy } from "./public-room-occupancy";
let expiresAt = 0;
let snapshot = new Map<string, PublicRoomOccupancy["spans"]>();
export function replacePublicRoomOccupancy(rows: PublicRoomOccupancy[]) {
  expiresAt = Date.now() + 60_000;
  snapshot = new Map(rows.map(row => [row.roomChoice, row.spans]));
}
export function readPublicRoomOccupancy(roomChoice: string) { return Date.now() < expiresAt ? snapshot.get(roomChoice) : undefined; }
