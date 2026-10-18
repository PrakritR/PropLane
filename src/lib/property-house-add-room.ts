import { emptyRoom, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

/**
 * Add room opens the room form on a copy of the listing that already holds the new, blank room.
 * Nothing is written until the manager presses Save in that form: cancelling (or closing) simply
 * drops the copy, so no empty "Room N" row is ever left behind.
 */
export function submissionWithNewRoom(sub: ManagerListingSubmissionV1): {
  sub: ManagerListingSubmissionV1;
  roomId: string;
} {
  const rooms = sub.rooms ?? [];
  const room = emptyRoom(rooms.length);
  return { sub: { ...sub, rooms: [...rooms, room] }, roomId: room.id };
}

/**
 * Save of a pending Add room: the form has been editing a COPY of the listing, so the row it
 * added is grafted onto whatever the listing holds now. A server sync that landed while the form
 * was open keeps its rooms and every other field, instead of being overwritten by the snapshot
 * the form opened on. The room is appended once — replaced in place if the listing already holds
 * that id.
 */
export function mergeAddedRoomIntoLatest(
  latest: ManagerListingSubmissionV1,
  edited: ManagerListingSubmissionV1,
  roomId: string,
): ManagerListingSubmissionV1 {
  const added = (edited.rooms ?? []).find((room) => room.id === roomId);
  if (!added) return latest;
  const rooms = latest.rooms ?? [];
  return {
    ...latest,
    rooms: rooms.some((room) => room.id === roomId)
      ? rooms.map((room) => (room.id === roomId ? added : room))
      : [...rooms, added],
  };
}
