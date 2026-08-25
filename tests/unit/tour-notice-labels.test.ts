import { describe, expect, it } from "vitest";
import { tourNoticeDaysLabel, TOUR_NOTICE_DAY_SELECT_OPTIONS } from "@/lib/tour-notice-labels";

describe("tourNoticeDaysLabel", () => {
  it("labels same-day and next-day options for managers", () => {
    expect(tourNoticeDaysLabel(0)).toBe("Same day");
    expect(tourNoticeDaysLabel(1)).toBe("Next day (1 day notice)");
    expect(tourNoticeDaysLabel(7)).toBe("1 week notice");
  });

  it("exposes every offered notice option", () => {
    expect(TOUR_NOTICE_DAY_SELECT_OPTIONS.map((o) => o.value)).toEqual([0, 1, 2, 3, 7]);
  });
});
