import { describe, expect, it } from "vitest";
import { availabilityLabelFromPublicSpans, pacificListingDay } from "@/lib/public-room-occupancy";

describe("public room availability labels", () => {
  const today = new Date(2026, 8, 26);

  it("shows a blank raw room as available when no public occupancy spans exist", () => {
    expect(availabilityLabelFromPublicSpans([], 1, today)).toBe("Available now");
  });

  it("treats a full shared room as occupied and a partly filled one as available", () => {
    const spans = [{ start: "2020-01-01", end: null, count: 2 }];
    expect(availabilityLabelFromPublicSpans(spans, 2, today)).toBe("Unavailable (occupied)");
    expect(availabilityLabelFromPublicSpans([{ ...spans[0], count: 1 }], 2, today)).toBe("Available now");
  });

  it("uses the public listing's upcoming-block wording", () => {
    expect(availabilityLabelFromPublicSpans([{ start: "2026-09-30", end: null, count: 1 }], 1, today))
      .toBe("Available now until September 29, 2026");
  });

  it("keeps the Pacific listing day when UTC has rolled into tomorrow", () => {
    const day = pacificListingDay(new Date("2026-09-27T02:00:00Z"));
    expect(availabilityLabelFromPublicSpans([{ start: "2026-09-27", end: null, count: 1 }], 1, day))
      .toBe("Available now until September 26, 2026");
  });
});
