import { describe, expect, it } from "vitest";
import { mergeAddedRoomIntoLatest, submissionWithNewRoom } from "@/lib/property-house-add-room";
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

describe("mergeAddedRoomIntoLatest", () => {
  it("grafts the new room onto the listing as it stands now, keeping a sync that landed meanwhile", () => {
    const base = { title: "House", rooms: [{ id: "room-a", name: "Room 1" }] } as unknown as ManagerListingSubmissionV1;
    const { sub: snapshot, roomId } = submissionWithNewRoom(base);
    const edited = {
      ...snapshot,
      rooms: (snapshot.rooms ?? []).map((room) => (room.id === roomId ? { ...room, name: "Attic" } : room)),
    } as ManagerListingSubmissionV1;
    // A server sync landed while the form was open: a second room and a new title.
    const latest = {
      title: "House (synced)",
      rooms: [{ id: "room-a", name: "Room 1" }, { id: "room-b", name: "Room 2" }],
    } as unknown as ManagerListingSubmissionV1;

    const merged = mergeAddedRoomIntoLatest(latest, edited, roomId);
    expect(merged.title).toBe("House (synced)");
    expect(merged.rooms?.map((room) => room.id)).toEqual(["room-a", "room-b", roomId]);
    expect(merged.rooms?.find((room) => room.id === roomId)?.name).toBe("Attic");
  });

  it("replaces in place rather than duplicating when the listing already holds the id", () => {
    const edited = { rooms: [{ id: "room-a", name: "Edited" }] } as unknown as ManagerListingSubmissionV1;
    const latest = { rooms: [{ id: "room-a", name: "Stale" }] } as unknown as ManagerListingSubmissionV1;
    const merged = mergeAddedRoomIntoLatest(latest, edited, "room-a");
    expect(merged.rooms).toHaveLength(1);
    expect(merged.rooms?.[0].name).toBe("Edited");
  });

  it("leaves the listing alone when the edited copy no longer holds the room", () => {
    const latest = { rooms: [{ id: "room-a", name: "Room 1" }] } as unknown as ManagerListingSubmissionV1;
    expect(mergeAddedRoomIntoLatest(latest, { rooms: [] } as unknown as ManagerListingSubmissionV1, "gone")).toBe(latest);
  });
});
