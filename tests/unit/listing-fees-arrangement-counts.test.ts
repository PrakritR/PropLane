/**
 * N082: a fee scoped to a SHARED-ROOM arrangement head count
 * (`room.occupancyPrices[].count`, room-arrangement-pricing.ts) — absent or
 * empty means every arrangement, an unknown count is never a reason to drop a
 * fee, and the scope survives the row normalizer the way `roomIds` and
 * `residentSlots` do. Same shape as `feeAppliesToResidentSlot`, but a
 * different axis: this keys on HOW MANY people share the room, not on which
 * named resident holds a per-resident-priced slot.
 */
import { describe, expect, it } from "vitest";
import { feeAppliesToArrangementCount, normalizeListingFeeRow, type ListingFeeRow } from "@/lib/listing-fees";

function fee(over: Partial<ListingFeeRow> = {}): ListingFeeRow {
  return { id: "fee-cleaning", label: "Cleaning fee", amount: "30", frequency: "one-time", ...over };
}

describe("feeAppliesToArrangementCount", () => {
  it("applies to every arrangement when the fee names no count", () => {
    expect(feeAppliesToArrangementCount(fee(), 1)).toBe(true);
    expect(feeAppliesToArrangementCount(fee({ arrangementCounts: [] }), 2)).toBe(true);
  });

  it("applies only to the named counts", () => {
    const scoped = fee({ arrangementCounts: [2] });
    expect(feeAppliesToArrangementCount(scoped, 2)).toBe(true);
    expect(feeAppliesToArrangementCount(scoped, 1)).toBe(false);
    expect(feeAppliesToArrangementCount(scoped, 3)).toBe(false);
  });

  it("applies when the count is unknown — a fee is never dropped for want of a count", () => {
    const scoped = fee({ arrangementCounts: [3] });
    expect(feeAppliesToArrangementCount(scoped, undefined)).toBe(true);
    expect(feeAppliesToArrangementCount(scoped, null)).toBe(true);
    expect(feeAppliesToArrangementCount(scoped, 0)).toBe(true);
  });
});

describe("normalizeListingFeeRow keeps arrangementCounts", () => {
  it("stores a real narrowing, sorted and de-duplicated", () => {
    expect(normalizeListingFeeRow(fee({ arrangementCounts: [3, 2, 3] })).arrangementCounts).toEqual([2, 3]);
  });

  it("stores an empty or junk scope as absent, meaning every arrangement", () => {
    expect(normalizeListingFeeRow(fee({ arrangementCounts: [] })).arrangementCounts).toBeUndefined();
    expect(normalizeListingFeeRow(fee({ arrangementCounts: [0, -1, 21, NaN] })).arrangementCounts).toBeUndefined();
    expect(normalizeListingFeeRow(fee()).arrangementCounts).toBeUndefined();
  });

  it("reads numeric strings from an older save", () => {
    expect(normalizeListingFeeRow(fee({ arrangementCounts: ["3", "2"] as unknown as number[] })).arrangementCounts).toEqual([2, 3]);
  });

  it("never drops arrangementCounts on an ordinary re-save (the normalizer rebuilds every row as a fresh literal)", () => {
    const saved = normalizeListingFeeRow(fee({ arrangementCounts: [2], roomIds: ["room-1"] }));
    const resaved = normalizeListingFeeRow({ ...saved, label: "Cleaning fee (renamed)" });
    expect(resaved.arrangementCounts).toEqual([2]);
  });
});
