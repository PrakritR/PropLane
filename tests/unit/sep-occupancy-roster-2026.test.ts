import { describe, expect, it } from "vitest";
import {
  occupancyImportAxisId,
  SEP_2026_OCCUPANCY_SEGMENTS,
} from "@/lib/sep-occupancy-roster-2026";
import { isShortTermName } from "@/lib/sales-workbook-roster";

describe("sep occupancy roster 2026", () => {
  it("classifies Airbnb-prefixed names as airbnb lease term", () => {
    for (const row of SEP_2026_OCCUPANCY_SEGMENTS) {
      if (isShortTermName(row.name)) {
        expect(row.leaseTerm).toBe("airbnb");
      }
    }
  });

  it("uses stable import ids per segment", () => {
    const id = occupancyImportAxisId("mgr-seed-4709a-8th-ave-ne", 2, "2026-09-03", "Airbnb Shaqran");
    expect(id).toMatch(/^OCC-2026-09-/);
    expect(occupancyImportAxisId("mgr-seed-4709a-8th-ave-ne", 2, "2026-09-03", "Airbnb Shaqran")).toBe(id);
  });

  it("covers all three Brooklyn/8th Ave properties", () => {
    const ids = new Set(SEP_2026_OCCUPANCY_SEGMENTS.map((s) => s.propertyId));
    expect(ids).toEqual(
      new Set([
        "mgr-seed-4709a-8th-ave-ne",
        "mgr--9-rooms-b1wf3z",
        "mgr-seed-5259-brooklyn-ave-ne",
      ]),
    );
  });
});
