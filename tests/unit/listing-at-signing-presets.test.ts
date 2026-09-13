import { describe, expect, it } from "vitest";
import { PRESET_IDS_OFFERED_AT_SIGNING, paymentAtSigningRows } from "@/lib/listing-fee-scope";
import { LISTING_FEE_PRESETS } from "@/lib/listing-fees";

/**
 * Due at signing used to offer only the manager's own custom fees plus the
 * security deposit and move-in fee, so a property with parking, HOA or a holding
 * deposit could never collect them up front and the receipt under-counted.
 */
describe("which built-in fees may be collected at signing", () => {
  it("names only ids that actually exist in the preset catalogue", () => {
    // `listing-fee-scope` cannot import `listing-fees` (that would be a cycle),
    // so the set is hand-declared there. This is the guard that keeps the two
    // from drifting apart.
    const known = new Set(LISTING_FEE_PRESETS.map((p) => p.presetId));
    for (const id of PRESET_IDS_OFFERED_AT_SIGNING) {
      expect(known.has(id as never)).toBe(true);
    }
  });

  it("leaves out the two that already have a standard row", () => {
    expect(PRESET_IDS_OFFERED_AT_SIGNING.has("security_deposit")).toBe(false);
    expect(PRESET_IDS_OFFERED_AT_SIGNING.has("move_in_fee")).toBe(false);
  });

  it("leaves out fees charged when a lease ENDS", () => {
    expect(PRESET_IDS_OFFERED_AT_SIGNING.has("break_lease_fee")).toBe(false);
    expect(PRESET_IDS_OFFERED_AT_SIGNING.has("holdover_daily")).toBe(false);
  });

  it("offers the built-in fees a property really can collect up front", () => {
    const rows = paymentAtSigningRows({
      customFees: [
        { id: "f1", label: "Parking", amount: "75", presetId: "parking_monthly" },
        { id: "f2", label: "HOA / community", amount: "40", presetId: "hoa_monthly" },
        { id: "f3", label: "Holding deposit", amount: "300", presetId: "holding_deposit" },
        { id: "f4", label: "Break lease fee", amount: "500", presetId: "break_lease_fee" },
        { id: "f5", label: "Cleaning", amount: "120", presetId: "custom" },
      ],
      rooms: [],
      removedStandardListingFeeRows: [],
    } as never);

    const labels = rows.map((r) => r.label);
    expect(labels).toContain("Parking");
    expect(labels).toContain("HOA / community");
    expect(labels).toContain("Holding deposit");
    expect(labels).toContain("Cleaning");
    // Charged on termination, never at signing.
    expect(labels).not.toContain("Break lease fee");
    // Still exactly one row each for the standard payments.
    expect(labels.filter((l) => l === "Security deposit")).toHaveLength(1);
    expect(labels.filter((l) => l === "Move-in fee")).toHaveLength(1);
  });

  it("still drops a standard row the manager deleted", () => {
    const rows = paymentAtSigningRows({
      customFees: [],
      rooms: [],
      removedStandardListingFeeRows: ["moveInFee"],
    } as never);
    expect(rows.map((r) => r.label)).not.toContain("Move-in fee");
  });
});
