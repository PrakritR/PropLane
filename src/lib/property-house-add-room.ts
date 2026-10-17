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
