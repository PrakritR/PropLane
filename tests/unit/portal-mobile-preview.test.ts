import { describe, expect, it } from "vitest";
import {
  formatCompactChargeLine,
  formatCompactPlacementLine,
  portalListPreviewLimit,
  sliceForPortalPreview,
  stripPropertyRoomCountSuffix,
} from "@/lib/portal-mobile-preview";

describe("portal mobile preview helpers", () => {
  it("limits native previews tighter than mobile web", () => {
    expect(portalListPreviewLimit(true)).toBe(3);
    expect(portalListPreviewLimit(false)).toBe(5);
    expect(portalListPreviewLimit(null)).toBe(5);
  });

  it("strips room-count suffix from property titles", () => {
    expect(stripPropertyRoomCountSuffix("5259 Brooklyn Ave NE · 9 rooms")).toBe("5259 Brooklyn Ave NE");
  });

  it("compacts lease placement labels to room + rent", () => {
    expect(
      formatCompactPlacementLine("5259 Brooklyn Ave NE · 9 rooms · Room 8", "$825.00/mo"),
    ).toBe("Room 8 · $825.00/mo");
  });

  it("keeps short placement labels when not room-house pattern", () => {
    expect(formatCompactPlacementLine("Unit 2A", "$900/mo")).toBe("Unit 2A · $900/mo");
  });

  it("formats compact charge lines", () => {
    expect(formatCompactChargeLine("Rent — July 2026", "$825.00", "Jul 1, 2026")).toBe(
      "Rent · July 2026 · $825.00 · Jul 1, 2026",
    );
  });

  it("slices lists for preview with overflow count", () => {
    const items = [1, 2, 3, 4, 5, 6];
    expect(sliceForPortalPreview(items, true)).toEqual({ visible: [1, 2, 3], overflow: 3 });
    expect(sliceForPortalPreview(items, false)).toEqual({ visible: [1, 2, 3, 4, 5], overflow: 1 });
  });
});
