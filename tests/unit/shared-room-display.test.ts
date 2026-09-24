import { describe, expect, it } from "vitest";
import {
  propertyListResidentsGlyph,
  sharedRoomApplicationFact,
  sharedRoomPricingSummaryLine,
  leaseSharedRoomOccupancySentence,
} from "@/lib/shared-room-display";

describe("shared-room-display", () => {
  it("propertyListResidentsGlyph only when a room holds 2+", () => {
    expect(propertyListResidentsGlyph([{ occupancyCapacity: 1 }, { occupancyCapacity: 1 }])).toBeNull();
    expect(propertyListResidentsGlyph([{ occupancyCapacity: 1 }, { occupancyCapacity: 2 }])).toBe(3);
  });

  it("sharedRoomPricingSummaryLine", () => {
    expect(sharedRoomPricingSummaryLine(1, 1000)).toBeNull();
    expect(sharedRoomPricingSummaryLine(2, 1000)).toBe("2 residents · $1,000 each");
  });

  it("sharedRoomApplicationFact", () => {
    expect(sharedRoomApplicationFact(2, 1000)).toBe("Shared · 2 residents · $1,000/mo each");
    expect(sharedRoomApplicationFact(2, null)).toBe("Shared · 2 residents");
  });

  it("leaseSharedRoomOccupancySentence", () => {
    expect(leaseSharedRoomOccupancySentence(2, "$1,000")).toMatch(/up to 2 residents/);
    expect(leaseSharedRoomOccupancySentence(2, "$1,000")).toMatch(/not split/);
    expect(leaseSharedRoomOccupancySentence(1, "$1,000")).toBeNull();
  });
});
