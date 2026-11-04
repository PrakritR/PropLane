import { describe, expect, it } from "vitest";
import { intersectVisitWindows, quoteTotalCents, type CoordinationQuote } from "@/lib/vendor-coordination";

const quote: CoordinationQuote = {
  laborCents: 12_000,
  materialsCents: 3_500,
  consultationFeeCents: 6_000,
  scope: "Inspect the kitchen leak",
  exclusions: "No wall repair",
};

describe("vendor coordination terms", () => {
  it("keeps consultation fee distinct from the later repair quote", () => {
    expect(quoteTotalCents("consultation", quote)).toBe(6_000);
    expect(quoteTotalCents("repair", quote)).toBe(15_500);
  });

  it("rejects fractional, negative, and oversized money", () => {
    expect(() => quoteTotalCents("repair", { ...quote, laborCents: 10.1 })).toThrow();
    expect(() => quoteTotalCents("consultation", { ...quote, consultationFeeCents: -1 })).toThrow();
    expect(() => quoteTotalCents("repair", { ...quote, laborCents: 1_000_000_000 })).toThrow();
  });

  it("intersects vendor and resident windows and subtracts busy visits", () => {
    expect(intersectVisitWindows(
      [{ startIso: "2026-11-02T16:00:00Z", endIso: "2026-11-02T20:00:00Z" }],
      [{ startIso: "2026-11-02T17:00:00Z", endIso: "2026-11-02T21:00:00Z" }],
      [{ startIso: "2026-11-02T18:00:00Z", endIso: "2026-11-02T19:00:00Z" }],
      60,
    )).toEqual([
      { startIso: "2026-11-02T17:00:00.000Z", endIso: "2026-11-02T18:00:00.000Z" },
      { startIso: "2026-11-02T19:00:00.000Z", endIso: "2026-11-02T20:00:00.000Z" },
    ]);
  });

  it("does not infer openness from a missing participant window", () => {
    expect(intersectVisitWindows(
      [{ startIso: "2026-11-02T16:00:00Z", endIso: "2026-11-02T20:00:00Z" }], [], [], 60,
    )).toEqual([]);
  });

  it("treats DST ambiguity as a conversion problem at input, using exact instants here", () => {
    expect(intersectVisitWindows(
      [{ startIso: "2026-11-01T05:00:00Z", endIso: "2026-11-01T07:00:00Z" }],
      [{ startIso: "2026-11-01T06:00:00Z", endIso: "2026-11-01T08:00:00Z" }], [], 60,
    )).toEqual([{ startIso: "2026-11-01T06:00:00.000Z", endIso: "2026-11-01T07:00:00.000Z" }]);
  });
});
