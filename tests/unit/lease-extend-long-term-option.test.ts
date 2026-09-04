/**
 * Regression guard for the resident "extend move-out" options.
 *
 * `extendMoveOutTypesForProperty` built its "Long term" choice by filtering the
 * listing's terms with /^\d+-Month$/. The moment listings started offering
 * "Long-term" instead of 3/6/9/12-Month (AXI-143), that filter matched nothing
 * and the resident silently lost the Long term option — a live feature removed
 * by a vocabulary change three files away.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/rental-application/data", () => ({
  listingAllowedLeaseTerms: (propertyId: string) =>
    propertyId === "modern"
      ? ["Long-term", "Month-to-Month", "Custom"]
      : propertyId === "legacy"
        ? ["12-Month", "6-Month", "Month-to-Month"]
        : [],
}));

const { extendMoveOutTypesForProperty } = await import("@/lib/lease-renewal-terms");

const idsFor = (propertyId: string) => extendMoveOutTypesForProperty(propertyId).map((o) => o.id);

describe("extend move-out options", () => {
  it("offers Long term on a listing using the new vocabulary", () => {
    expect(idsFor("modern")).toContain("long_term");
  });

  it("carries the actual term through, not a hardcoded length", () => {
    const longTerm = extendMoveOutTypesForProperty("modern").find((o) => o.id === "long_term");
    expect(longTerm && "leaseTerms" in longTerm ? longTerm.leaseTerms : []).toContain("Long-term");
  });

  it("still offers Long term on a listing that kept the old lengths", () => {
    const longTerm = extendMoveOutTypesForProperty("legacy").find((o) => o.id === "long_term");
    expect(longTerm && "leaseTerms" in longTerm ? longTerm.leaseTerms : []).toEqual(
      expect.arrayContaining(["6-Month", "12-Month"]),
    );
  });

  it("offers month-to-month when the listing allows it", () => {
    expect(idsFor("modern")).toContain("month_to_month");
    expect(idsFor("legacy")).toContain("month_to_month");
  });

  it("always keeps Custom as the escape hatch", () => {
    for (const id of ["modern", "legacy", "unknown"]) expect(idsFor(id)).toContain("custom");
  });

  it("falls back to the offered choices for a listing with no stored terms", () => {
    // Not the full accepted set — that still carries the retired lengths.
    expect(idsFor("unknown")).toContain("long_term");
    expect(idsFor("unknown")).toContain("month_to_month");
  });
});
