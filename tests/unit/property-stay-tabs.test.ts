import { describe, expect, it } from "vitest";
import {
  allowedStays,
  inStay,
  rowsInStay,
  stayCounts,
  stayTabItems,
  stayTabsFor,
} from "@/lib/property-stay-tabs";

const longOnly = { allowedLeaseTerms: ["Long-term"], shortTermRentalsAllowed: false, airbnbRentalsAllowed: false };
const both = { allowedLeaseTerms: ["Long-term", "Short-Term Stay"], shortTermRentalsAllowed: true, airbnbRentalsAllowed: false };
const airbnb = { allowedLeaseTerms: ["Long-term"], shortTermRentalsAllowed: false, airbnbRentalsAllowed: true };

describe("property-stay-tabs", () => {
  it("reads the allowed stays from the listing's lease terms", () => {
    expect(allowedStays(longOnly)).toEqual(["long_term"]);
    expect(allowedStays(both)).toEqual(["long_term", "short_term"]);
  });

  it("counts Airbnb as a short-term stay", () => {
    expect(allowedStays(airbnb)).toContain("short_term");
  });

  it("a property that never stated a choice is long term only, never empty", () => {
    expect(allowedStays({})).toEqual(["long_term"]);
    expect(allowedStays(null)).toEqual(["long_term"]);
  });

  it("hides the short-term tab on a long-term-only property", () => {
    expect(stayTabsFor(longOnly)).toEqual(["long_term"]);
    expect(stayTabsFor(both)).toEqual(["long_term", "short_term"]);
  });

  it("never hides data: a disallowed stay that still has rows keeps its tab", () => {
    expect(stayTabsFor(longOnly, ["short_term"])).toEqual(["long_term", "short_term"]);
    expect(stayTabsFor(longOnly, { short_term: 2, long_term: 0 })).toEqual(["long_term", "short_term"]);
    expect(stayTabsFor(longOnly, { short_term: 0 })).toEqual(["long_term"]);
  });

  it("a row for both stays shows in both tabs; absent reads as both", () => {
    expect(inStay("both", "long_term")).toBe(true);
    expect(inStay("both", "short_term")).toBe(true);
    expect(inStay(undefined, "short_term")).toBe(true);
    expect(inStay("long_term", "short_term")).toBe(false);
    expect(inStay("short_term", "long_term")).toBe(false);
  });

  it("filters rows and counts per stay", () => {
    const rows = [
      { id: "a", appliesTo: "long_term" as const },
      { id: "b", appliesTo: "short_term" as const },
      { id: "c", appliesTo: "both" as const },
      { id: "d", appliesTo: undefined },
    ];
    const of = (r: (typeof rows)[number]) => r.appliesTo;
    expect(rowsInStay(rows, "long_term", of).map((r) => r.id)).toEqual(["a", "c", "d"]);
    expect(rowsInStay(rows, "short_term", of).map((r) => r.id)).toEqual(["b", "c", "d"]);
    expect(stayCounts(rows, of)).toEqual({ long_term: 3, short_term: 3 });
  });

  it("builds tab items with the property's stays and counts", () => {
    expect(stayTabItems(both, { long_term: 2, short_term: 1 })).toEqual([
      { id: "long_term", label: "Long term", count: 2 },
      { id: "short_term", label: "Short term", count: 1 },
    ]);
    expect(stayTabItems(longOnly, { long_term: 2, short_term: 0 }).map((t) => t.id)).toEqual(["long_term"]);
  });
});
