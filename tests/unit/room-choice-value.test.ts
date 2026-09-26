import { describe, expect, it } from "vitest";
import {
  canonicalRoomChoiceValue,
  parseRoomChoiceValue,
  roomChoiceValue,
} from "@/lib/rental-application/room-choice-value";

describe("room-choice values", () => {
  it("reads a room whose id looks like a slot as that room, not property + slot", () => {
    // Imported and legacy rooms keep ids like "r1"; a slot only ever follows property::room.
    expect(parseRoomChoiceValue("p::r1")).toEqual({ propertyId: "p", listingRoomId: "r1" });
    expect(canonicalRoomChoiceValue("p::r1")).toBe("p::r1");
    expect(canonicalRoomChoiceValue("p::r2")).not.toBe(canonicalRoomChoiceValue("p::r1"));
  });

  it("reads the slot written by roomChoiceValue", () => {
    const value = roomChoiceValue("p", "r1", 2);
    expect(value).toBe("p::r1::r2");
    expect(parseRoomChoiceValue(value)).toEqual({ propertyId: "p", listingRoomId: "r1", residentSlot: 2 });
    expect(canonicalRoomChoiceValue(value)).toBe("p::r1");
  });

  it("keeps property-only and plain room values unchanged", () => {
    expect(parseRoomChoiceValue("p")).toEqual({ propertyId: "p" });
    expect(parseRoomChoiceValue("p::room_abc")).toEqual({ propertyId: "p", listingRoomId: "room_abc" });
    expect(parseRoomChoiceValue("  ")).toEqual({ propertyId: "" });
  });
});
