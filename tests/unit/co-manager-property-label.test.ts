import { describe, expect, it } from "vitest";
import { labelFromManagerPropertyRecordRow } from "@/lib/co-manager-property-label";

describe("labelFromManagerPropertyRecordRow", () => {
  it("joins building and unit", () => {
    expect(
      labelFromManagerPropertyRecordRow({
        id: "prop-1",
        property_data: { buildingName: "4709A 8th Ave NE", unitLabel: "Unit A" },
      }),
    ).toBe("4709A 8th Ave NE · Unit A");
  });

  it("appends room count when building alone", () => {
    expect(
      labelFromManagerPropertyRecordRow({
        id: "prop-2",
        row_data: { buildingName: "5257 Brooklyn Ave NE", roomCount: 9 },
      }),
    ).toBe("5257 Brooklyn Ave NE · 9 rooms");
  });

  it("falls back to id", () => {
    expect(labelFromManagerPropertyRecordRow({ id: "prop-3", property_data: {} })).toBe("prop-3");
  });
});
