/**
 * A fee scoped to a resident slot of a shared room (PLAN-0920-0631): absent or
 * empty means every resident, an unknown slot is never a reason to drop a fee,
 * and the scope survives the row normalizer the way `roomIds` does.
 */
import { describe, expect, it } from "vitest";
import { feeAppliesToArrangement, feeAppliesToResidentSlot, normalizeListingFeeRow, type ListingFeeRow } from "@/lib/listing-fees";

function fee(over: Partial<ListingFeeRow> = {}): ListingFeeRow {
  return { id: "fee-parking", label: "Parking", amount: "50", frequency: "monthly", ...over };
}

describe("feeAppliesToResidentSlot", () => {
  it("applies to every resident when the fee names no slot", () => {
    expect(feeAppliesToResidentSlot(fee(), 1)).toBe(true);
    expect(feeAppliesToResidentSlot(fee({ residentSlots: [] }), 2)).toBe(true);
  });

  it("applies only to the named slots", () => {
    const scoped = fee({ residentSlots: [1] });
    expect(feeAppliesToResidentSlot(scoped, 1)).toBe(true);
    expect(feeAppliesToResidentSlot(scoped, 2)).toBe(false);
  });

  it("applies when the slot is unknown — a fee is never dropped for want of a slot number", () => {
    const scoped = fee({ residentSlots: [2] });
    expect(feeAppliesToResidentSlot(scoped, undefined)).toBe(true);
    expect(feeAppliesToResidentSlot(scoped, null)).toBe(true);
    expect(feeAppliesToResidentSlot(scoped, 0)).toBe(true);
  });
});

describe("feeAppliesToArrangement", () => {
  it("bills every arrangement when the fee names none", () => {
    expect(feeAppliesToArrangement(fee(), 1)).toBe(true);
    expect(feeAppliesToArrangement(fee(), 2)).toBe(true);
  });

  it("bills only residents who take the named arrangement", () => {
    const shared = fee({ arrangementCounts: [2] });
    expect(feeAppliesToArrangement(shared, 2)).toBe(true);
    expect(feeAppliesToArrangement(shared, 1)).toBe(false);
  });
});

describe("normalizeListingFeeRow keeps arrangementCounts", () => {
  it("stores the head counts a fee bills", () => {
    expect(normalizeListingFeeRow(fee({ arrangementCounts: [2, 2, 1] })).arrangementCounts).toEqual([1, 2]);
  });
});

describe("normalizeListingFeeRow keeps residentSlots", () => {
  it("stores a real narrowing, sorted and de-duplicated", () => {
    expect(normalizeListingFeeRow(fee({ residentSlots: [2, 1, 2] })).residentSlots).toEqual([1, 2]);
  });

  it("stores an empty or junk scope as absent, meaning every resident", () => {
    expect(normalizeListingFeeRow(fee({ residentSlots: [] })).residentSlots).toBeUndefined();
    expect(normalizeListingFeeRow(fee({ residentSlots: [0, -1, 21, NaN] })).residentSlots).toBeUndefined();
    expect(normalizeListingFeeRow(fee()).residentSlots).toBeUndefined();
  });

  it("reads numeric strings from an older save", () => {
    expect(normalizeListingFeeRow(fee({ residentSlots: ["2", "1"] as unknown as number[] })).residentSlots).toEqual([1, 2]);
  });
});
