// PLAN-0921-1648: duplicating an untouched (still-default-named or blank) room
// or bathroom card used to hand the copy "<prefix> (copy)" or "Room (copy)" /
// "Bathroom (copy)" — a name that no longer matches the default "<prefix> N"
// slot pattern, so `isRoomSlotRemovable` / `isBathroomSlotRemovable` treated
// the copy as permanently non-removable even though it holds nothing. An
// untouched source now hands the copy the NEXT free default slot name
// instead, so the copy stays untouched and removable. A custom-named source
// still gets "<name> (copy)".
import { describe, expect, it } from "vitest";
import {
  duplicateBathroomEntry,
  duplicateRoomEntry,
  emptyBathroom,
  emptyRoom,
  isBathroomSlotRemovable,
  isRoomSlotRemovable,
} from "@/lib/manager-listing-submission";

describe("duplicating an untouched room takes the next default slot name", () => {
  it("duplicating untouched Room 2 in a 3-room listing yields Room 4 and is removable", () => {
    const rooms = [emptyRoom(0), emptyRoom(1), emptyRoom(2)];
    const source = rooms[1]!;
    expect(source.name).toBe("Room 2");
    expect(isRoomSlotRemovable(source)).toBe(true);

    const copy = duplicateRoomEntry(source, { siblingNames: rooms.map((r) => r.name) });

    expect(copy.name).toBe("Room 4");
    expect(copy.id).not.toBe(source.id);
    expect(isRoomSlotRemovable(copy)).toBe(true);
  });

  it("duplicating a blank (empty-name) room also takes the next default slot name", () => {
    const rooms = [{ ...emptyRoom(0), name: "" }, emptyRoom(1)];
    const source = rooms[0]!;
    expect(isRoomSlotRemovable(source)).toBe(true);

    const copy = duplicateRoomEntry(source, { siblingNames: rooms.map((r) => r.name) });

    expect(copy.name).toBe("Room 3");
    expect(isRoomSlotRemovable(copy)).toBe(true);
  });

  it("duplicating a custom-named room keeps '<name> (copy)'", () => {
    const rooms = [{ ...emptyRoom(0), name: "Sunroom" }, emptyRoom(1)];
    const source = rooms[0]!;
    expect(isRoomSlotRemovable(source)).toBe(false);

    const copy = duplicateRoomEntry(source, { siblingNames: rooms.map((r) => r.name) });

    expect(copy.name).toBe("Sunroom (copy)");
    expect(isRoomSlotRemovable(copy)).toBe(false);
  });

  it("never collides with the positional label a blank sibling wears after the copy is inserted", () => {
    // Two untouched cards with no names at all: the step labels them "Room 1"
    // and "Room 2" by position. Inserting the copy at index 1 pushes the second
    // blank card to position 3, so "Room 3" is NOT free — it is what that card
    // will read as.
    const rooms = [
      { ...emptyRoom(0), name: "" },
      { ...emptyRoom(1), name: "" },
    ];

    const copy = duplicateRoomEntry(rooms[0]!, { siblingNames: rooms.map((r) => r.name), insertIndex: 1 });

    const labels = [rooms[0]!, copy, rooms[1]!].map((r, i) => r.name.trim() || `Room ${i + 1}`);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toEqual(["Room 1", "Room 4", "Room 3"]);
    expect(isRoomSlotRemovable(copy)).toBe(true);
  });

  it("does the same for bathrooms", () => {
    const bathrooms = [
      { ...emptyBathroom(0), name: "" },
      { ...emptyBathroom(1), name: "" },
    ];

    const copy = duplicateBathroomEntry(bathrooms[0]!, {
      siblingNames: bathrooms.map((b) => b.name),
      insertIndex: 1,
    });

    const labels = [bathrooms[0]!, copy, bathrooms[1]!].map((b, i) => b.name.trim() || `Bathroom ${i + 1}`);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toEqual(["Bathroom 1", "Bathroom 4", "Bathroom 3"]);
    expect(isBathroomSlotRemovable(copy)).toBe(true);
  });

  it("renumbers around an existing gap so the new default name never collides", () => {
    // Room 1, Room 2, and a duplicate already sitting at "Room 4" (e.g. from
    // an earlier duplicate) — the next free default slot is Room 5, not Room 3.
    const rooms = [emptyRoom(0), emptyRoom(1), { ...emptyRoom(2), name: "Room 4" }];
    const source = rooms[0]!;

    const copy = duplicateRoomEntry(source, { siblingNames: rooms.map((r) => r.name) });

    expect(copy.name).toBe("Room 5");
  });
});

describe("duplicating an untouched bathroom takes the next default slot name", () => {
  it("duplicating untouched Bathroom 2 in a 3-bathroom listing yields Bathroom 4 and is removable", () => {
    const bathrooms = [emptyBathroom(0), emptyBathroom(1), emptyBathroom(2)];
    const source = bathrooms[1]!;
    expect(source.name).toBe("Bathroom 2");
    expect(isBathroomSlotRemovable(source)).toBe(true);

    const copy = duplicateBathroomEntry(source, { siblingNames: bathrooms.map((b) => b.name) });

    expect(copy.name).toBe("Bathroom 4");
    expect(copy.id).not.toBe(source.id);
    expect(isBathroomSlotRemovable(copy)).toBe(true);
  });

  it("duplicating a blank (empty-name) bathroom also takes the next default slot name", () => {
    const bathrooms = [{ ...emptyBathroom(0), name: "" }, emptyBathroom(1)];
    const source = bathrooms[0]!;
    expect(isBathroomSlotRemovable(source)).toBe(true);

    const copy = duplicateBathroomEntry(source, { siblingNames: bathrooms.map((b) => b.name) });

    expect(copy.name).toBe("Bathroom 3");
    expect(isBathroomSlotRemovable(copy)).toBe(true);
  });

  it("duplicating a custom-named bathroom keeps '<name> (copy)'", () => {
    const bathrooms = [{ ...emptyBathroom(0), name: "Powder room" }, emptyBathroom(1)];
    const source = bathrooms[0]!;
    expect(isBathroomSlotRemovable(source)).toBe(false);

    const copy = duplicateBathroomEntry(source, { siblingNames: bathrooms.map((b) => b.name) });

    expect(copy.name).toBe("Powder room (copy)");
    expect(isBathroomSlotRemovable(copy)).toBe(false);
  });
});
