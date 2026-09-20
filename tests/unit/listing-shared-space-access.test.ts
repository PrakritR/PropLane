import { describe, expect, it } from "vitest";
import {
  EVERYONE_ACCESS_VALUE,
  encodeSharedSpaceAccessPick,
  encodeSharedSpaceEveryone,
  retainSharedSpaceAccessAfterRoomsChange,
  sharedSpaceAccessMenuSelected,
  sharedSpaceAccessNames,
  sharedSpaceAccessOptions,
  sharedSpaceAccessTriggerLabel,
  sharedSpaceIsEveryone,
} from "@/lib/listing-shared-space-access";

const rooms = ["r1", "r2", "r3"] as const;

describe("sharedSpaceIsEveryone", () => {
  it("reads empty and the full current list as Everyone", () => {
    expect(sharedSpaceIsEveryone([], rooms)).toBe(true);
    expect(sharedSpaceIsEveryone(undefined, rooms)).toBe(true);
    expect(sharedSpaceIsEveryone(["r1", "r2", "r3"], rooms)).toBe(true);
    expect(sharedSpaceIsEveryone(["r1", "r2"], rooms)).toBe(false);
  });

  it("is Everyone when there are no rooms", () => {
    expect(sharedSpaceIsEveryone(["r1"], [])).toBe(true);
  });
});

describe("encodeSharedSpaceAccessPick", () => {
  it("stores Everyone as an empty list", () => {
    expect(encodeSharedSpaceEveryone()).toEqual([]);
    expect(
      encodeSharedSpaceAccessPick({
        nextSelected: [EVERYONE_ACCESS_VALUE, ...rooms],
        roomIds: rooms,
        previousAccessIds: ["r1"],
      }),
    ).toEqual([]);
  });

  it("unticking one room from Everyone stores the rest", () => {
    expect(
      encodeSharedSpaceAccessPick({
        nextSelected: [EVERYONE_ACCESS_VALUE, "r1", "r3"],
        roomIds: rooms,
        previousAccessIds: [],
      }),
    ).toEqual(["r1", "r3"]);
  });

  it("ticking the last missing room returns Everyone", () => {
    expect(
      encodeSharedSpaceAccessPick({
        nextSelected: ["r1", "r2", "r3"],
        roomIds: rooms,
        previousAccessIds: ["r1", "r2"],
      }),
    ).toEqual([]);
  });

  it("unticking Everyone while every room is still selected stays Everyone", () => {
    expect(
      encodeSharedSpaceAccessPick({
        nextSelected: [...rooms],
        roomIds: rooms,
        previousAccessIds: [],
      }),
    ).toEqual([]);
  });

  it("cannot store nobody", () => {
    expect(
      encodeSharedSpaceAccessPick({
        nextSelected: [EVERYONE_ACCESS_VALUE],
        roomIds: rooms,
        previousAccessIds: ["r1"],
      }),
    ).toEqual([]);
    expect(
      encodeSharedSpaceAccessPick({
        nextSelected: [],
        roomIds: rooms,
        previousAccessIds: ["r1"],
      }),
    ).toEqual([]);
  });
});

describe("menu + trigger", () => {
  it("checks Everyone and every room when access is empty", () => {
    expect(sharedSpaceAccessMenuSelected([], rooms)).toEqual([EVERYONE_ACCESS_VALUE, "r1", "r2", "r3"]);
    expect(sharedSpaceAccessTriggerLabel([], rooms)).toBe("Everyone");
    expect(sharedSpaceAccessTriggerLabel(["r1", "r2", "r3"], rooms)).toBe("Everyone");
  });

  it("shows a room count when narrowed", () => {
    expect(sharedSpaceAccessMenuSelected(["r1"], rooms)).toEqual(["r1"]);
    expect(sharedSpaceAccessTriggerLabel(["r1"], rooms)).toBe("1 room");
    expect(sharedSpaceAccessTriggerLabel(["r1", "r2"], rooms)).toBe("2 rooms");
  });

  it("pins Everyone as the first option", () => {
    expect(
      sharedSpaceAccessOptions([
        { id: "r1", name: "Room A" },
        { id: "r2", name: "" },
      ]),
    ).toEqual([
      { value: EVERYONE_ACCESS_VALUE, label: "Everyone" },
      { value: "r1", label: "Room A" },
      { value: "r2", label: "Room 2" },
    ]);
  });
});

describe("retainSharedSpaceAccessAfterRoomsChange", () => {
  it("keeps Everyone when a room is added or removed", () => {
    expect(retainSharedSpaceAccessAfterRoomsChange([], ["r1", "r2"], ["r1", "r2", "r3"])).toEqual([]);
    expect(retainSharedSpaceAccessAfterRoomsChange(["r1", "r2"], ["r1", "r2"], ["r1", "r2", "r3"])).toEqual([]);
    expect(retainSharedSpaceAccessAfterRoomsChange([], ["r1", "r2", "r3"], ["r1", "r2"])).toEqual([]);
  });

  it("keeps a narrowed subset and drops removed rooms", () => {
    expect(retainSharedSpaceAccessAfterRoomsChange(["r1"], ["r1", "r2"], ["r1", "r2", "r3"])).toEqual(["r1"]);
    expect(retainSharedSpaceAccessAfterRoomsChange(["r1", "r2"], ["r1", "r2", "r3"], ["r2", "r3"])).toEqual(["r2"]);
  });

  it("bounces a subset that lost its last room back to Everyone", () => {
    expect(retainSharedSpaceAccessAfterRoomsChange(["r1"], ["r1", "r2"], ["r2"])).toEqual([]);
  });
});

describe("sharedSpaceAccessNames", () => {
  const named = [
    { id: "r1", name: "Room A" },
    { id: "r2", name: "Room B" },
  ];

  it("says Everyone instead of listing every room", () => {
    expect(sharedSpaceAccessNames([], named)).toBe("Everyone");
    expect(sharedSpaceAccessNames(["r1", "r2"], named)).toBe("Everyone");
  });

  it("lists a narrowed subset by name", () => {
    expect(sharedSpaceAccessNames(["r1"], named)).toBe("Room A");
  });
});
