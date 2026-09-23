import { describe, expect, it } from "vitest";
import {
  canonicalRoomChoiceValue,
  expandFirstChoiceRoomOptions,
  parseRoomChoiceValue,
  roomChoiceValue,
} from "@/lib/rental-application/data";

describe("room choice slot encoding", () => {
  it("keeps listingRoomId when a resident slot suffix is present", () => {
    expect(parseRoomChoiceValue("listing-a::room-9::r2")).toEqual({
      propertyId: "listing-a",
      listingRoomId: "room-9",
      residentSlot: 2,
    });
    expect(canonicalRoomChoiceValue("listing-a::room-9::r2")).toBe("listing-a::room-9");
    expect(roomChoiceValue("listing-a", "room-9", 2)).toBe("listing-a::room-9::r2");
  });

  it("leaves a room-level choice unchanged", () => {
    expect(parseRoomChoiceValue("listing-a::room-9")).toEqual({
      propertyId: "listing-a",
      listingRoomId: "room-9",
    });
    expect(canonicalRoomChoiceValue("listing-a::room-9")).toBe("listing-a::room-9");
  });
});

describe("expandFirstChoiceRoomOptions", () => {
  it("lists one row per bed and marks a taken slot", () => {
    const room = {
      name: "Room 9",
      monthlyRent: 1200,
      occupancyCapacity: 2,
      residentPricing: "per_resident" as const,
      residentPrices: [{ monthlyRent: 1050 }, { monthlyRent: 1200 }],
    };
    const options = expandFirstChoiceRoomOptions({
      rooms: [{ value: "listing-a::room-9", label: "Room 9 · $1,200/mo" }],
      resolveRoom: () => room,
      resolveSlots: () => ({
        slots: [
          { slot: 1, monthlyRent: 1050, taken: true },
          { slot: 2, monthlyRent: 1200, taken: false },
        ],
        allTakenByCount: false,
      }),
    });
    expect(options).toEqual([
      {
        value: "listing-a::room-9::r1",
        label: "Room 9 · Resident 1 · $1,050/mo · Taken",
        disabled: true,
      },
      {
        value: "listing-a::room-9::r2",
        label: "Room 9 · Resident 2 · $1,200/mo",
        disabled: false,
      },
    ]);
  });

  it("keeps the applicant's current taken bed selectable", () => {
    const room = {
      name: "Room 9",
      monthlyRent: 1200,
      occupancyCapacity: 2,
      residentPricing: "per_resident" as const,
      residentPrices: [{ monthlyRent: 1050 }, { monthlyRent: 1200 }],
    };
    const options = expandFirstChoiceRoomOptions({
      rooms: [{ value: "listing-a::room-9", label: "Room 9" }],
      keepValue: "listing-a::room-9::r1",
      resolveRoom: () => room,
      resolveSlots: () => ({
        slots: [
          { slot: 1, monthlyRent: 1050, taken: true },
          { slot: 2, monthlyRent: 1200, taken: false },
        ],
        allTakenByCount: false,
      }),
    });
    expect(options[0]?.disabled).toBe(false);
    expect(options[1]?.disabled).toBe(false);
  });
});
