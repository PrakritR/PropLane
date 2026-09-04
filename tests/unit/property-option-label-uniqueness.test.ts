import { describe, expect, it } from "vitest";

import { disambiguatePropertyOptionLabels } from "@/lib/manager-portfolio-access";

/**
 * `buildingName` is optional, so an unnamed listing falls back to a generic
 * "Property · N rooms" placeholder — and EVERY such listing renders the same
 * string, so a manager with two of them cannot tell which is which (PRP-211).
 * A nuisance in most dropdowns; a hazard in the co-manager property picker,
 * where picking the wrong row grants a third party access to the wrong
 * property.
 */
const GENERIC = "Property · 3 rooms";

describe("disambiguatePropertyOptionLabels", () => {
  it("leaves distinct labels completely alone", () => {
    const options = [
      { id: "p1", label: "Brooklyn House", address: "1 A St" },
      { id: "p2", label: "Ballard House", address: "2 B St" },
    ];
    expect(disambiguatePropertyOptionLabels(options)).toEqual(options);
  });

  it("separates duplicates by address, which is how managers refer to a property", () => {
    const out = disambiguatePropertyOptionLabels([
      { id: "p1", label: GENERIC, address: "230 Alder Row" },
      { id: "p2", label: GENERIC, address: "88 Pine Way" },
    ]);
    expect(out.map((o) => o.label)).toEqual([
      "Property · 3 rooms · 230 Alder Row",
      "Property · 3 rooms · 88 Pine Way",
    ]);
    expect(new Set(out.map((o) => o.label)).size).toBe(2);
  });

  it("falls back to the id when even the address is shared", () => {
    const out = disambiguatePropertyOptionLabels([
      { id: "prop-aaaaaa", label: GENERIC, address: "230 Alder Row" },
      { id: "prop-bbbbbb", label: GENERIC, address: "230 Alder Row" },
    ]);
    expect(new Set(out.map((o) => o.label)).size).toBe(2);
    expect(out[1]!.label).toContain("bbbbbb");
  });

  it("handles a missing address without producing a dangling separator", () => {
    const out = disambiguatePropertyOptionLabels([
      { id: "prop-111111", label: GENERIC },
      { id: "prop-222222", label: GENERIC, address: "" },
    ]);
    expect(new Set(out.map((o) => o.label)).size).toBe(2);
    for (const option of out) expect(option.label.endsWith("·")).toBe(false);
  });

  it("never returns the same label twice, whatever the input", () => {
    const out = disambiguatePropertyOptionLabels([
      { id: "a1", label: GENERIC, address: "Same St" },
      { id: "a2", label: GENERIC, address: "Same St" },
      { id: "a3", label: GENERIC, address: "Same St" },
    ]);
    expect(new Set(out.map((o) => o.label)).size).toBe(3);
  });

  it("does not append an address that merely repeats the label", () => {
    const out = disambiguatePropertyOptionLabels([
      { id: "p1", label: "230 Alder Row", address: "230 Alder Row" },
      { id: "p2", label: "230 Alder Row", address: "230 Alder Row" },
    ]);
    expect(out[0]!.label).not.toBe("230 Alder Row · 230 Alder Row");
    expect(new Set(out.map((o) => o.label)).size).toBe(2);
  });
});
