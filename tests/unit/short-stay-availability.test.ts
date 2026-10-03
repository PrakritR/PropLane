import { describe, expect, it } from "vitest";
import { shortStayRangeHasRoom } from "@/lib/short-stay-availability";

describe("shortStayRangeHasRoom", () => {
  it("rejects a stay that overlaps a booked span", () => {
    const spans = [{ start: "2026-10-10", end: "2026-10-12", count: 1 }];
    expect(shortStayRangeHasRoom(spans, 1, "2026-10-09", "2026-10-11")).toBe(false);
    expect(shortStayRangeHasRoom(spans, 1, "2026-10-13", "2026-10-15")).toBe(true);
  });
});
