import { describe, expect, it } from "vitest";
import { matchesPortalListSearch, portalSearchTerms } from "@/lib/portal-list-search";

describe("matchesPortalListSearch", () => {
  it("matches everything on an empty or blank query", () => {
    expect(matchesPortalListSearch("", "Vivek")).toBe(true);
    expect(matchesPortalListSearch("   ", "Vivek")).toBe(true);
    expect(matchesPortalListSearch(undefined, "Vivek")).toBe(true);
  });

  it("ignores case and accents", () => {
    expect(matchesPortalListSearch("VIVEK", "Vivek", "5259 Brooklyn Ave")).toBe(true);
    expect(matchesPortalListSearch("jose", "José Álvarez")).toBe(true);
    expect(matchesPortalListSearch("álvarez", "Jose Alvarez")).toBe(true);
  });

  it("requires every word, across any field", () => {
    expect(matchesPortalListSearch("brooklyn 9", "Prakrit", "5257 Brooklyn Ave · Room 9")).toBe(true);
    expect(matchesPortalListSearch("brooklyn 8th", "Prakrit", "5257 Brooklyn Ave · Room 9")).toBe(false);
    expect(matchesPortalListSearch("rent october", "Rent — October 2026", "Prakrit")).toBe(true);
  });

  it("skips empty and nullish fields without matching them", () => {
    expect(matchesPortalListSearch("null", "Vivek", null, undefined, "")).toBe(false);
    expect(matchesPortalListSearch("vivek", null, undefined, "Vivek")).toBe(true);
  });

  it("splits terms on any whitespace", () => {
    expect(portalSearchTerms("  a\tb\n c ")).toEqual(["a", "b", "c"]);
    expect(portalSearchTerms("")).toEqual([]);
  });
});
