import { describe, expect, it } from "vitest";
import {
  dominantPropertyLabel,
  groupHouseLabel,
  groupSpansMultipleProperties,
  numberGroupsByHouse,
} from "@/lib/rental-application/group-house-label";

const BROOKLYN_5257 = "5257 Brooklyn Ave NE";
const BROOKLYN_5259 = "5259 Brooklyn Ave NE";

describe("dominantPropertyLabel", () => {
  it("anchors a split group to the house most of its rows sit at", () => {
    // The real shape that broke the Applications header: 3 at 5257, 1 at 5259.
    expect(
      dominantPropertyLabel([
        { property: BROOKLYN_5257 },
        { property: BROOKLYN_5259 },
        { property: BROOKLYN_5257 },
        { property: BROOKLYN_5257 },
      ]),
    ).toBe(BROOKLYN_5257);
  });

  it("strips the room-count suffix the Leases rows carry", () => {
    expect(dominantPropertyLabel([{ property: "5257 Brooklyn Ave NE · 9 rooms" }])).toBe(BROOKLYN_5257);
  });

  it("is null only when no row names a property", () => {
    expect(dominantPropertyLabel([{ property: "" }, { property: "   " }])).toBeNull();
    expect(dominantPropertyLabel([])).toBeNull();
  });

  it("breaks ties stably rather than on row order", () => {
    const a = dominantPropertyLabel([{ property: BROOKLYN_5259 }, { property: BROOKLYN_5257 }]);
    const b = dominantPropertyLabel([{ property: BROOKLYN_5257 }, { property: BROOKLYN_5259 }]);
    expect(a).toBe(b);
  });
});

describe("groupSpansMultipleProperties", () => {
  it("is true for a split household and false for a single-house one", () => {
    expect(groupSpansMultipleProperties([{ property: BROOKLYN_5257 }, { property: BROOKLYN_5259 }])).toBe(true);
    expect(groupSpansMultipleProperties([{ property: BROOKLYN_5257 }, { property: BROOKLYN_5257 }])).toBe(false);
  });
});

describe("numberGroupsByHouse", () => {
  it("numbers groups WITHIN each house, so every house starts at 1", () => {
    const map = numberGroupsByHouse([
      { groupId: "PROPLANE-AAA", property: BROOKLYN_5257 },
      { groupId: "PROPLANE-AAA", property: BROOKLYN_5257 },
      { groupId: "PROPLANE-BBB", property: BROOKLYN_5257 },
      { groupId: "PROPLANE-CCC", property: BROOKLYN_5259 },
    ]);
    expect(map.get("PROPLANE-AAA")).toEqual({ property: BROOKLYN_5257, ordinal: 1 });
    expect(map.get("PROPLANE-BBB")).toEqual({ property: BROOKLYN_5257, ordinal: 2 });
    // A different house restarts at 1 — a global counter would read as a bug here.
    expect(map.get("PROPLANE-CCC")).toEqual({ property: BROOKLYN_5259, ordinal: 1 });
  });

  it("gives the same ordinal regardless of row order", () => {
    const rows = [
      { groupId: "PROPLANE-BBB", property: BROOKLYN_5257 },
      { groupId: "PROPLANE-AAA", property: BROOKLYN_5257 },
    ];
    const forward = numberGroupsByHouse(rows);
    const reversed = numberGroupsByHouse([...rows].reverse());
    expect(forward.get("PROPLANE-AAA")!.ordinal).toBe(reversed.get("PROPLANE-AAA")!.ordinal);
    expect(forward.get("PROPLANE-BBB")!.ordinal).toBe(reversed.get("PROPLANE-BBB")!.ordinal);
  });

  it("ignores rows with no group and normalizes case", () => {
    const map = numberGroupsByHouse([
      { groupId: "", property: BROOKLYN_5257 },
      { groupId: "proplane-aaa", property: BROOKLYN_5257 },
    ]);
    expect(map.size).toBe(1);
    expect(map.get("PROPLANE-AAA")!.ordinal).toBe(1);
  });
});

describe("groupHouseLabel", () => {
  it("names the house, which is the whole point", () => {
    expect(groupHouseLabel(BROOKLYN_5257, 1)).toBe("5257 Brooklyn Ave NE Group 1");
  });

  it("degrades to a bare group label when no house is known", () => {
    expect(groupHouseLabel(null, 2)).toBe("Group 2");
  });
});
