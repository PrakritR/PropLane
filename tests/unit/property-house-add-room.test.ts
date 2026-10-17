import { describe, expect, it } from "vitest";
import { submissionWithNewRoom } from "@/lib/property-house-add-room";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

describe("submissionWithNewRoom", () => {
  const base = { rooms: [{ id: "room-a", name: "Room 1" }] } as unknown as ManagerListingSubmissionV1;

  it("returns a copy holding the new room and never mutates the saved listing", () => {
    const { sub, roomId } = submissionWithNewRoom(base);
    expect(base.rooms).toHaveLength(1);
    expect(sub.rooms).toHaveLength(2);
    expect(sub.rooms?.[1].id).toBe(roomId);
    expect(roomId).not.toBe("room-a");
  });

  it("works on a listing with no rooms yet", () => {
    const { sub, roomId } = submissionWithNewRoom({} as ManagerListingSubmissionV1);
    expect(sub.rooms).toHaveLength(1);
    expect(sub.rooms?.[0].id).toBe(roomId);
  });
});
