import { describe, expect, it } from "vitest";
import { AXIS_VENDOR_CATALOG } from "@/lib/axis-vendor-catalog";
import { filterVendorsForIssue, onlineDirectoryHits, zipsForSelectedProperties } from "@/lib/vendor-issue-search";

const roster = [
  { id: "s", name: "s", trade: "Plumbing", phone: "206-555-0100", zip: "98105" },
  { id: "hvac-own", name: "Own HVAC", trade: "HVAC", zip: "98105" },
];

describe("vendor-issue-search", () => {
  it("filters roster + catalog by issue and property ZIP", () => {
    const { roster: own, catalog } = filterVendorsForIssue({
      issue: "plumbing",
      propertyZips: ["98105", "98004"],
      roster,
    });
    expect(own.map((h) => h.id)).toEqual(["s"]);
    expect(catalog.some((h) => h.name === "Emerald City Plumbing")).toBe(true);
    expect(catalog.some((h) => h.trade === "HVAC")).toBe(false);
  });

  it("does not return catalog vendors the manager already owns", () => {
    const { catalog } = filterVendorsForIssue({
      issue: "HVAC",
      propertyZips: ["98104"],
      roster: [{ id: "1", name: "Sound HVAC Collective", trade: "HVAC" }],
    });
    expect(catalog.some((h) => h.name === "Sound HVAC Collective")).toBe(false);
  });

  it("online hits are directory facts only — no persist side effect", () => {
    const hits = onlineDirectoryHits({ issue: "pest", propertyZips: ["98122"] });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.name && h.trade && !("imageUrl" in h) && !("email" in h))).toBe(true);
    expect(AXIS_VENDOR_CATALOG.find((row) => row.catalogId === hits[0]!.id)).toBeTruthy();
  });

  it("empty issue still returns ZIP-near catalog rows", () => {
    const hits = onlineDirectoryHits({ issue: "", propertyZips: ["98101"] });
    expect(hits.some((h) => h.city.toLowerCase().includes("seattle") || h.id.includes("handyman"))).toBe(true);
  });

  it("empty selected property ids means every house ZIP", () => {
    expect(
      zipsForSelectedProperties(
        [
          { id: "a", zip: "98105" },
          { id: "b", zip: "98004" },
          { id: "a-dup", zip: "98105" },
        ],
        [],
      ),
    ).toEqual(["98105", "98004"]);
    expect(zipsForSelectedProperties([{ id: "a", zip: "98105" }, { id: "b", zip: "98004" }], ["b"])).toEqual([
      "98004",
    ]);
  });
});
