import { describe, expect, it } from "vitest";
import { ID_LIST_KEYS, mergePendingAddSubmission, submissionWithNewRoom } from "@/lib/property-house-add-room";
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

  it("hands back the pre-add listing as the merge base", () => {
    const { base: baseOut } = submissionWithNewRoom(base);
    expect(baseOut).toBe(base);
  });
});

describe("mergePendingAddSubmission", () => {
  const listing = {
    title: "House",
    rooms: [{ id: "room-a", name: "Room 1", monthlyRent: 900 }],
    bathrooms: [],
  } as unknown as ManagerListingSubmissionV1;

  it("saves the new room AND the bathroom the room form minted for it", () => {
    const { base, sub: snapshot, roomId } = submissionWithNewRoom(listing);
    // Name the room, then pick a private bathroom: the editor mints a `bathrooms[]` row carrying
    // the room link (what `applyRoomBathroom` / `addBathroomForRoom` do).
    const edited = {
      ...snapshot,
      rooms: (snapshot.rooms ?? []).map((room) => (room.id === roomId ? { ...room, name: "Attic" } : room)),
      bathrooms: [{ id: "bath-new", name: "Bathroom 1", access: "private", roomIds: [roomId] }],
    } as unknown as ManagerListingSubmissionV1;

    const merged = mergePendingAddSubmission({ base, latest: listing, edited });
    expect(merged.rooms?.map((room) => room.id)).toEqual(["room-a", roomId]);
    expect(merged.rooms?.find((room) => room.id === roomId)?.name).toBe("Attic");
    expect(merged.bathrooms).toHaveLength(1);
    expect(merged.bathrooms?.[0]).toMatchObject({ id: "bath-new", roomIds: [roomId] });
  });

  it("keeps a concurrent sync's change to another room's price", () => {
    const { base, sub: snapshot, roomId } = submissionWithNewRoom(listing);
    const edited = {
      ...snapshot,
      rooms: (snapshot.rooms ?? []).map((room) => (room.id === roomId ? { ...room, name: "Attic" } : room)),
    } as unknown as ManagerListingSubmissionV1;
    // A sync landed while the form was open: Room 1 repriced, a second room added, new title.
    const latest = {
      title: "House (synced)",
      rooms: [
        { id: "room-a", name: "Room 1", monthlyRent: 1100 },
        { id: "room-b", name: "Room 2", monthlyRent: 1200 },
      ],
      bathrooms: [],
    } as unknown as ManagerListingSubmissionV1;

    const merged = mergePendingAddSubmission({ base, latest, edited });
    expect(merged.title).toBe("House (synced)");
    expect(merged.rooms?.map((room) => room.id)).toEqual(["room-a", "room-b", roomId]);
    expect(merged.rooms?.find((room) => room.id === "room-a")?.monthlyRent).toBe(1100);
    expect(merged.rooms?.find((room) => room.id === "room-b")?.monthlyRent).toBe(1200);
    expect(merged.rooms?.find((room) => room.id === roomId)?.name).toBe("Attic");
  });

  it("the form's own edit to an existing row wins over the sync's", () => {
    const { base, sub: snapshot, roomId } = submissionWithNewRoom(listing);
    const edited = {
      ...snapshot,
      rooms: (snapshot.rooms ?? []).map((room) =>
        room.id === "room-a" ? { ...room, name: "Renamed in the form" } : room,
      ),
    } as unknown as ManagerListingSubmissionV1;
    const latest = {
      ...listing,
      rooms: [{ id: "room-a", name: "Renamed by the sync", monthlyRent: 900 }],
    } as unknown as ManagerListingSubmissionV1;

    const merged = mergePendingAddSubmission({ base, latest, edited });
    expect(merged.rooms?.find((room) => room.id === "room-a")?.name).toBe("Renamed in the form");
    expect(merged.rooms?.some((room) => room.id === roomId)).toBe(true);
  });

  it("never resurrects a row the sync deleted", () => {
    const { base, sub: snapshot, roomId } = submissionWithNewRoom(listing);
    const latest = { ...listing, rooms: [] } as unknown as ManagerListingSubmissionV1;

    const merged = mergePendingAddSubmission({ base, latest, edited: snapshot });
    expect(merged.rooms?.map((room) => room.id)).toEqual([roomId]);
  });

  it("leaves a field the form never touched alone", () => {
    const { base, sub: snapshot } = submissionWithNewRoom(listing);
    const latest = { ...listing, title: "Changed elsewhere" } as unknown as ManagerListingSubmissionV1;

    const merged = mergePendingAddSubmission({ base, latest, edited: snapshot });
    expect(merged.title).toBe("Changed elsewhere");
  });

  it("works when the listing had no rooms or bathrooms at all", () => {
    const empty = {} as ManagerListingSubmissionV1;
    const { base, sub: snapshot, roomId } = submissionWithNewRoom(empty);
    const edited = {
      ...snapshot,
      bathrooms: [{ id: "bath-new", name: "Bathroom 1", roomIds: [roomId] }],
    } as unknown as ManagerListingSubmissionV1;

    const merged = mergePendingAddSubmission({ base, latest: empty, edited });
    expect(merged.rooms?.map((room) => room.id)).toEqual([roomId]);
    expect(merged.bathrooms?.map((bath) => bath.id)).toEqual(["bath-new"]);
  });
});

describe("every id-keyed list is merged, not just rooms and bathrooms", () => {
  const listing = {
    rooms: [{ id: "room-a", name: "Room 1" }],
    bathrooms: [],
    sharedSpaces: [{ id: "space-1", name: "Kitchen" }],
    bundles: [{ id: "bundle-1", label: "Pair" }],
    customFees: [{ id: "fee-1", label: "Parking" }],
  } as unknown as ManagerListingSubmissionV1;

  it("names the submission's id-keyed arrays in one place", () => {
    expect([...ID_LIST_KEYS]).toEqual(["rooms", "bathrooms", "sharedSpaces", "bundles", "customFees"]);
  });

  it.each(ID_LIST_KEYS.filter((key) => key !== "rooms"))("carries the form's change to %s", (key) => {
    const { base, sub: snapshot } = submissionWithNewRoom(listing);
    const rows = (snapshot as unknown as Record<string, { id: string }[]>)[key] ?? [];
    const edited = {
      ...snapshot,
      [key]: [...rows, { id: `${key}-minted`, name: "Minted", label: "Minted" }],
    } as unknown as ManagerListingSubmissionV1;

    const merged = mergePendingAddSubmission({ base, latest: listing, edited });
    const out = (merged as unknown as Record<string, { id: string }[]>)[key] ?? [];
    expect(out.map((row) => row.id)).toContain(`${key}-minted`);
    expect(out).toHaveLength(rows.length + 1);
  });

  it("keeps a sync's change to a list the form never touched", () => {
    const { base, sub: snapshot } = submissionWithNewRoom(listing);
    const latest = {
      ...listing,
      bundles: [{ id: "bundle-1", label: "Repriced by the sync" }],
    } as unknown as ManagerListingSubmissionV1;

    const merged = mergePendingAddSubmission({ base, latest, edited: snapshot });
    expect(merged.bundles?.[0]).toMatchObject({ label: "Repriced by the sync" });
  });
});
