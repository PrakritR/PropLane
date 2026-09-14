/**
 * Who "Block dates" can hold a room for: everyone on the lease pipeline, one
 * row per person (the shared identity rule), voided leases skipped.
 */
import { describe, expect, it } from "vitest";
import { blockDatesResidentOptions } from "@/lib/channel-calendar/block-dates-residents";

const labels = {
  propertyLabelForId: (id: string) => (id === "h1" ? "4709A 8th Ave NE" : ""),
  roomLabelForId: (_p: string, roomId: string) => (roomId === "r3" ? "Room 3" : ""),
};

describe("blockDatesResidentOptions", () => {
  it("lists one option per person, sorted by name, with where they are", () => {
    const options = blockDatesResidentOptions(
      [
        { id: "l1", residentName: "Maya Zuneh", residentEmail: "Maya@Example.com", propertyId: "h1", roomChoice: "h1::r3" },
        { id: "l2", residentName: "Maya Zuneh", residentEmail: "maya@example.com", propertyId: "h1", roomChoice: "h1::r3" },
        { id: "l3", residentName: "Alex Rivera", residentEmail: "", propertyId: "h1", roomChoice: null },
        { id: "l4", residentName: "Gone Person", residentEmail: "gone@example.com", voidedAt: "2026-01-01T00:00:00Z" },
        { id: "l5", residentName: "", residentEmail: "" },
      ],
      labels,
    );
    expect(options).toEqual([
      { key: "name:alex rivera", name: "Alex Rivera", email: "", meta: "4709A 8th Ave NE" },
      { key: "email:maya@example.com", name: "Maya Zuneh", email: "maya@example.com", meta: "Room 3 · 4709A 8th Ave NE" },
    ]);
  });

  it("is empty for a manager with no one on the books", () => {
    expect(blockDatesResidentOptions([], labels)).toEqual([]);
  });
});
