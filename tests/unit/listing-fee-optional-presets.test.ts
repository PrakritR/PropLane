/**
 * "And now just simplify the price" / "So much customization is bulky."
 *
 * Seven fee presets were flagged `requiredInWizard`, and the error they raised said
 * the quiet part out loud: "<fee> is required — enter 0 if there is no fee." A
 * landlord with no HOA, no parking and no month-to-month surcharge still had to
 * answer for all three before the listing would save.
 *
 * A blank amount now means the fee does not exist. The security deposit is the one
 * exception: it stays on the simplified Price screen, pre-filled with one month's
 * rent, so it is asked once and never guessed.
 */
import { describe, expect, it } from "vitest";
import {
  CORE_LISTING_FEE_PRESET_IDS,
  LISTING_FEE_PRESETS,
  presetListingFeeRow,
  validateListingFeeRows,
} from "@/lib/listing-fees";
import type { ListingFeePresetId } from "@/lib/listing-fees";

const OPTIONAL_NOW: ListingFeePresetId[] = [
  "move_in_fee",
  "parking_monthly",
  "hoa_monthly",
  "other_monthly",
  "mtm_surcharge",
  "custom_lease_surcharge",
];

describe("a fee a landlord does not charge is simply left blank", () => {
  it.each(OPTIONAL_NOW)("does not block the listing on a blank %s", (presetId) => {
    const rows = [presetListingFeeRow(presetId, "")];
    expect(validateListingFeeRows(rows, false)).toEqual({});
  });

  it("still asks for the security deposit — the one number on the Price screen", () => {
    const errs = validateListingFeeRows([presetListingFeeRow("security_deposit", "")], false);
    expect(Object.keys(errs).length).toBeGreaterThan(0);
  });

  it("accepts an explicit zero deposit for a landlord who takes none", () => {
    expect(validateListingFeeRows([presetListingFeeRow("security_deposit", "0")], false)).toEqual({});
  });

  it("leaves security deposit as the ONLY preset that forces an answer", () => {
    const required = LISTING_FEE_PRESETS.filter((p) => p.requiredInWizard).map((p) => p.presetId);
    expect(required).toEqual(["security_deposit"]);
  });

  it("keeps every preset available — none was deleted, only un-required", () => {
    for (const presetId of OPTIONAL_NOW) {
      expect(LISTING_FEE_PRESETS.some((p) => p.presetId === presetId)).toBe(true);
    }
    expect(CORE_LISTING_FEE_PRESET_IDS).toContain("parking_monthly");
  });

  it("a whole blank fee sheet saves, except for the deposit", () => {
    const rows = OPTIONAL_NOW.map((id) => presetListingFeeRow(id, ""));
    expect(validateListingFeeRows(rows, false)).toEqual({});
  });
});
