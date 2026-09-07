import { describe, expect, it } from "vitest";
import { partitionTourAvailabilityStoredKeys } from "@/lib/tour-slot-math";

describe("tour availability published-slot detection (PRP-412)", () => {
  it("treats an empty store as no published open windows", () => {
    expect(partitionTourAvailabilityStoredKeys([]).publishedSlots).toEqual([]);
  });

  it("counts painted YYYY-MM-DD:hourIndex keys as published", () => {
    const { publishedSlots } = partitionTourAvailabilityStoredKeys([
      "2026-09-10:10",
      "2026-09-10:11",
    ]);
    expect(publishedSlots).toHaveLength(2);
  });
});
