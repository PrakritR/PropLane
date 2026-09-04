import { describe, expect, it } from "vitest";
import {
  buildCalendarCopyDestinationHouses,
  resolveCalendarCopySourcePropertyId,
} from "@/lib/calendar-copy-availability";

const portfolio = [
  { id: "house-a", name: "House A" },
  { id: "house-b", name: "House B" },
  { id: "house-c", name: "House C" },
];

describe("calendar copy availability helpers", () => {
  it("resolves a single filtered property as the copy source", () => {
    expect(resolveCalendarCopySourcePropertyId(["house-a"], ["house-a"])).toBe("house-a");
  });

  it("resolves the first filtered property when several are scoped", () => {
    expect(resolveCalendarCopySourcePropertyId(["house-a", "house-b"], ["house-a", "house-b"])).toBe(
      "house-a",
    );
  });

  it("resolves the first scoped house when the portfolio is unfiltered", () => {
    expect(resolveCalendarCopySourcePropertyId([], ["house-a", "house-b", "house-c"])).toBe("house-a");
  });

  it("lists every other house as a destination for one filtered source", () => {
    expect(buildCalendarCopyDestinationHouses("house-a", portfolio, ["house-a"])).toEqual([
      { id: "house-b", name: "House B" },
      { id: "house-c", name: "House C" },
    ]);
  });

  it("limits destinations to the other filtered houses when multiple filters are active", () => {
    expect(buildCalendarCopyDestinationHouses("house-a", portfolio, ["house-a", "house-b"])).toEqual([
      { id: "house-b", name: "House B" },
    ]);
  });

  it("lists every other scoped house when the portfolio is unfiltered", () => {
    expect(buildCalendarCopyDestinationHouses("house-a", portfolio, [])).toEqual([
      { id: "house-b", name: "House B" },
      { id: "house-c", name: "House C" },
    ]);
  });

  it("returns undefined when there is no destination house", () => {
    expect(buildCalendarCopyDestinationHouses("house-a", [{ id: "house-a", name: "House A" }], [])).toBeUndefined();
  });
});
