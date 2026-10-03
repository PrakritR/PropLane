import type {
  ManagerListingSubmissionV1,
  ManagerRoomSubmission,
  RoomPricingUiMeta,
} from "@/lib/manager-listing-submission";
import { copyRoomPricingFrom } from "@/lib/listing-house-defaults";
import { LONG_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";

export function resolveRoomPricingCopyLabel(
  sub: ManagerListingSubmissionV1,
  roomId: string,
  term: string,
): string | null {
  const meta = sub.roomPricingMeta?.[roomId];
  const fromId = meta?.copyFromRoomIdByTerm?.[term] ?? meta?.copyFromRoomIdByTerm?.[LONG_TERM_LEASE_TERM];
  if (!fromId) return null;
  const src = sub.rooms.find((r) => r.id === fromId);
  if (!src) return null;
  return `Same as ${src.name?.trim() || "Room"}`;
}

/** Rooms a manager may pick as a pricing copy source (no chains, not self). */
export function pricingCopySourceRooms(
  sub: ManagerListingSubmissionV1,
  roomId: string,
  term: string,
): ManagerRoomSubmission[] {
  const self = sub.rooms.find((r) => r.id === roomId);
  if (!self) return [];
  return sub.rooms.filter((candidate) => {
    if (candidate.id === roomId) return false;
    const meta = sub.roomPricingMeta?.[candidate.id];
    const follows = meta?.copyFromRoomIdByTerm?.[term];
    if (follows) return false;
    return candidate.monthlyRent > 0 || (candidate.occupancyPrices?.length ?? 0) > 0;
  });
}

export function setRoomPricingCopyFrom(
  sub: ManagerListingSubmissionV1,
  roomId: string,
  term: string,
  sourceRoomId: string | null,
): ManagerListingSubmissionV1 {
  const room = sub.rooms.find((r) => r.id === roomId);
  if (!room) return sub;
  const prevMeta: RoomPricingUiMeta = { ...(sub.roomPricingMeta?.[roomId] ?? {}) };
  const nextByTerm = { ...(prevMeta.copyFromRoomIdByTerm ?? {}) };
  if (!sourceRoomId) {
    delete nextByTerm[term];
  } else {
    nextByTerm[term] = sourceRoomId;
  }
  const meta: RoomPricingUiMeta = {
    ...prevMeta,
    copyFromRoomIdByTerm: Object.keys(nextByTerm).length ? nextByTerm : undefined,
    priceSource: "own",
  };
  let nextRoom = room;
  if (sourceRoomId) {
    const src = sub.rooms.find((r) => r.id === sourceRoomId);
    if (src) nextRoom = copyRoomPricingFrom(src, room);
  }
  const rooms = sub.rooms.map((r) => (r.id === roomId ? nextRoom : r));
  const roomPricingMeta = { ...(sub.roomPricingMeta ?? {}), [roomId]: meta };
  return { ...sub, rooms, roomPricingMeta };
}

export function clearRoomPricingCopyWhenSourceRemoved(
  sub: ManagerListingSubmissionV1,
  removedRoomId: string,
): ManagerListingSubmissionV1 {
  if (!sub.roomPricingMeta) return sub;
  let changed = false;
  const roomPricingMeta: Record<string, RoomPricingUiMeta> = {};
  for (const [id, meta] of Object.entries(sub.roomPricingMeta)) {
    const byTerm = meta.copyFromRoomIdByTerm;
    if (!byTerm) {
      roomPricingMeta[id] = meta;
      continue;
    }
    const next: Record<string, string> = {};
    for (const [term, from] of Object.entries(byTerm)) {
      if (!from || from === removedRoomId) {
        if (from === removedRoomId) changed = true;
        continue;
      }
      next[term] = from;
    }
    roomPricingMeta[id] = {
      ...meta,
      copyFromRoomIdByTerm: Object.keys(next).length ? next : undefined,
    };
  }
  return changed ? { ...sub, roomPricingMeta } : sub;
}
