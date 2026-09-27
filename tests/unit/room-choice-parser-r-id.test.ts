import { describe, expect, it } from "vitest";
import { canonicalRoomChoiceValue, parseRoomChoiceValue, roomChoiceValue } from "@/lib/rental-application/data";

describe("room ids that resemble resident slots", () => {
  it("keeps a two-segment r1 room id and reads a third-segment resident slot", () => {
    expect(parseRoomChoiceValue("home-1::r1")).toEqual({ propertyId: "home-1", listingRoomId: "r1" });
    expect(parseRoomChoiceValue(roomChoiceValue("home-1", "r1", 2))).toEqual({
      propertyId: "home-1", listingRoomId: "r1", residentSlot: 2,
    });
    expect(canonicalRoomChoiceValue("home-1::r1::r2")).toBe("home-1::r1");
  });
});
