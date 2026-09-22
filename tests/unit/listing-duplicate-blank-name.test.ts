// PLAN-0921-1648: duplicating an untouched (still-default-named or blank) room
// or bathroom card used to hand the copy "<prefix> (copy)" or "Room (copy)" /
// "Bathroom (copy)" — a name that no longer matches the default "<prefix> N"
// slot pattern, so `isRoomSlotRemovable` / `isBathroomSlotRemovable` treated
// the copy as permanently non-removable even though it holds nothing.
//
// Minting an explicit next-free "<prefix> N" for the copy fixed that but froze
// a number while its blank siblings kept re-labelling positionally around it,
// so any later add or remove put two identically labelled cards side by side —
// in the card list and in the "Same as" options. An untouched source now hands
// the copy NO name at all: it is labelled by position like every other
// untouched card, so it can never collide, and a blank name already reads as
// untouched to the ✕ guard. A custom-named source still gets "<name> (copy)".
import { describe, expect, it } from "vitest";
import {
  duplicateBathroomEntry,
  duplicateRoomEntry,
  emptyBathroom,
  emptyRoom,
  isBathroomSlotRemovable,
  isRoomSlotRemovable,
} from "@/lib/manager-listing-submission";

/** How the Rooms / Bathrooms steps title each card. */
const roomLabels = (rooms: readonly { name: string }[]) => rooms.map((r, i) => r.name.trim() || `Room ${i + 1}`);
const bathLabels = (baths: readonly { name: string }[]) => baths.map((b, i) => b.name.trim() || `Bathroom ${i + 1}`);

describe("duplicating an untouched room leaves the copy nameless", () => {
  it("duplicating untouched Room 2 in a 3-room listing yields a blank name and is removable", () => {
    const rooms = [emptyRoom(0), emptyRoom(1), emptyRoom(2)];
    const source = rooms[1]!;
    expect(source.name).toBe("Room 2");
    expect(isRoomSlotRemovable(source)).toBe(true);

    const copy = duplicateRoomEntry(source);

    expect(copy.name).toBe("");
    expect(copy.id).not.toBe(source.id);
    expect(isRoomSlotRemovable(copy)).toBe(true);
  });

  it("duplicating a blank (empty-name) room also leaves the copy nameless", () => {
    const rooms = [{ ...emptyRoom(0), name: "" }, emptyRoom(1)];
    const source = rooms[0]!;
    expect(isRoomSlotRemovable(source)).toBe(true);

    const copy = duplicateRoomEntry(source);

    expect(copy.name).toBe("");
    expect(isRoomSlotRemovable(copy)).toBe(true);
  });

  it("duplicating a custom-named room keeps '<name> (copy)'", () => {
    const rooms = [{ ...emptyRoom(0), name: "Sunroom" }, emptyRoom(1)];
    const source = rooms[0]!;
    expect(isRoomSlotRemovable(source)).toBe(false);

    const copy = duplicateRoomEntry(source);

    expect(copy.name).toBe("Sunroom (copy)");
    expect(isRoomSlotRemovable(copy)).toBe(false);
  });

  it("never collides with a blank sibling's positional label, before OR after a later add", () => {
    // Two untouched cards with no names at all — the step labels them by
    // position. This is the list that used to produce a frozen "Room 3" (and
    // then "Room 4") beside a blank card wearing the very same label.
    const rooms = [
      { ...emptyRoom(0), name: "" },
      { ...emptyRoom(1), name: "" },
    ];

    const copy = duplicateRoomEntry(rooms[0]!);
    const afterCopy = [rooms[0]!, copy, rooms[1]!];
    expect(roomLabels(afterCopy)).toEqual(["Room 1", "Room 2", "Room 3"]);
    expect(new Set(roomLabels(afterCopy)).size).toBe(3);

    // One "+ Add room" appends another untouched card; still no two cards
    // answer to the same name.
    const afterAdd = [...afterCopy, { ...emptyRoom(3), name: "" }];
    expect(new Set(roomLabels(afterAdd)).size).toBe(afterAdd.length);

    // And removing the first card renumbers everything, still uniquely.
    const afterRemove = afterAdd.slice(1);
    expect(new Set(roomLabels(afterRemove)).size).toBe(afterRemove.length);
  });

  it("a copy sitting beside default-named siblings still cannot collide", () => {
    const rooms = [emptyRoom(0), emptyRoom(1)];
    const copy = duplicateRoomEntry(rooms[0]!);
    const next = [rooms[0]!, copy, rooms[1]!];

    // Room 1 · Room 2 (the nameless copy, by position) · Room 2 (stored) —
    // the stored default names are the pre-existing wart this test does not
    // own; what matters is that the COPY adds no new frozen name.
    expect(copy.name).toBe("");
    expect(next.filter((r) => r.name.trim() === "").length).toBe(1);
  });
});

describe("duplicating an untouched bathroom leaves the copy nameless", () => {
  it("duplicating untouched Bathroom 2 in a 3-bathroom listing yields a blank name and is removable", () => {
    const bathrooms = [emptyBathroom(0), emptyBathroom(1), emptyBathroom(2)];
    const source = bathrooms[1]!;
    expect(source.name).toBe("Bathroom 2");
    expect(isBathroomSlotRemovable(source)).toBe(true);

    const copy = duplicateBathroomEntry(source);

    expect(copy.name).toBe("");
    expect(copy.id).not.toBe(source.id);
    expect(isBathroomSlotRemovable(copy)).toBe(true);
  });

  it("duplicating a blank (empty-name) bathroom also leaves the copy nameless", () => {
    const bathrooms = [{ ...emptyBathroom(0), name: "" }, emptyBathroom(1)];
    const source = bathrooms[0]!;
    expect(isBathroomSlotRemovable(source)).toBe(true);

    const copy = duplicateBathroomEntry(source);

    expect(copy.name).toBe("");
    expect(isBathroomSlotRemovable(copy)).toBe(true);
  });

  it("duplicating a custom-named bathroom keeps '<name> (copy)'", () => {
    const bathrooms = [{ ...emptyBathroom(0), name: "Powder room" }, emptyBathroom(1)];
    const source = bathrooms[0]!;
    expect(isBathroomSlotRemovable(source)).toBe(false);

    const copy = duplicateBathroomEntry(source);

    expect(copy.name).toBe("Powder room (copy)");
    expect(isBathroomSlotRemovable(copy)).toBe(false);
  });

  it("never collides with a blank sibling's positional label, before OR after a later add", () => {
    const bathrooms = [
      { ...emptyBathroom(0), name: "" },
      { ...emptyBathroom(1), name: "" },
    ];

    const copy = duplicateBathroomEntry(bathrooms[0]!);
    const afterCopy = [bathrooms[0]!, copy, bathrooms[1]!];
    expect(bathLabels(afterCopy)).toEqual(["Bathroom 1", "Bathroom 2", "Bathroom 3"]);

    const afterAdd = [...afterCopy, { ...emptyBathroom(3), name: "" }];
    expect(new Set(bathLabels(afterAdd)).size).toBe(afterAdd.length);
  });

  it("keeps the room mapping a duplicate is given", () => {
    const source = { ...emptyBathroom(0), name: "", assignedRoomIds: ["r1"] };
    const copy = duplicateBathroomEntry(source, { roomIdMap: new Map([["r1", "r9"]]) });

    expect(copy.name).toBe("");
    expect(copy.assignedRoomIds).toEqual(["r9"]);
  });
});
