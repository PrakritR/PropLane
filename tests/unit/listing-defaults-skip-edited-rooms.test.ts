/**
 * A room a manager has edited must stop following the "most rooms are…" row.
 *
 * The wizard used to judge inheritance per FIELD, so a manager who had set one
 * room's rent by hand still found that room's beds or deposit changing when
 * they later adjusted the house default. Overwriting an edited room is still
 * possible, but only through the explicit "Copy to all" control, which passes
 * `roomIds` and therefore forces.
 */
import { describe, expect, it } from "vitest";
import {
  applyHouseDefaultsToRooms,
  emptyListingHouseDefaults,
  roomsFollowingDefaults,
} from "@/lib/listing-house-defaults";
import type { ManagerRoomSubmission } from "@/lib/manager-listing-submission";

const room = (over: Partial<ManagerRoomSubmission> & { id: string }): ManagerRoomSubmission =>
  ({ name: "", monthlyRent: 0, ...over }) as ManagerRoomSubmission;

describe("rooms following the house defaults", () => {
  const defaults = { ...emptyListingHouseDefaults(), monthlyRent: 1050, occupancyCapacity: 1 };

  it("counts a room that matches the defaults as still following", () => {
    const rooms = [room({ id: "a", monthlyRent: 1050 }), room({ id: "b" })];
    expect(roomsFollowingDefaults(rooms, defaults)).toEqual(["a", "b"]);
  });

  it("drops a room the moment ANY field differs", () => {
    const rooms = [room({ id: "a", monthlyRent: 1050 }), room({ id: "b", monthlyRent: 1400 })];
    expect(roomsFollowingDefaults(rooms, defaults)).toEqual(["a"]);
  });

  it("leaves an edited room's untouched fields alone when a different default changes", () => {
    // Room b has its own rent. Raising the house bed count must not touch it.
    const rooms = [room({ id: "a", monthlyRent: 1050 }), room({ id: "b", monthlyRent: 1400 })];
    const next = { ...defaults, occupancyCapacity: 3 };
    const out = applyHouseDefaultsToRooms(rooms, next, {
      onlyFields: ["occupancyCapacity"],
      previousDefaults: defaults,
      roomIds: roomsFollowingDefaults(rooms, defaults),
    });
    expect(out.find((r) => r.id === "a")?.occupancyCapacity).toBe(3);
    expect(out.find((r) => r.id === "b")?.occupancyCapacity).toBeUndefined();
    expect(out.find((r) => r.id === "b")?.monthlyRent).toBe(1400);
  });

  it("still overwrites an edited room when every room is named explicitly", () => {
    const rooms = [room({ id: "a", monthlyRent: 1050 }), room({ id: "b", monthlyRent: 1400 })];
    const out = applyHouseDefaultsToRooms(rooms, defaults, { roomIds: rooms.map((r) => r.id) });
    expect(out.map((r) => r.monthlyRent)).toEqual([1050, 1050]);
  });
});
