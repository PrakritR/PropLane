import { describe, expect, it } from "vitest";
import {
  listingLeaseTermToResidentValue,
  residentLeaseTermOptionsForProperty,
  residentLeaseTermSelectValue,
  RESIDENT_LEASE_TERM_AIRBNB,
  RESIDENT_LEASE_TERM_CUSTOM,
  RESIDENT_LEASE_TERM_LONG,
  RESIDENT_LEASE_TERM_SHORT,
  normalizeApplicationLeaseTerm,
  residentLeaseTermToApplicationFields,
  shouldUseResidentLeaseCustomMode,
} from "@/lib/resident-manual-lease-terms";
import { AIRBNB_LEASE_TERM, SHORT_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";

describe("resident manual lease terms", () => {
  const presets = [
    RESIDENT_LEASE_TERM_SHORT,
    RESIDENT_LEASE_TERM_AIRBNB,
    RESIDENT_LEASE_TERM_LONG,
    RESIDENT_LEASE_TERM_CUSTOM,
  ] as const;

  it("offers short, airbnb, long, and custom lease options when all are allowed", () => {
    const options = residentLeaseTermOptionsForProperty("");
    expect(options.map((o) => o.value)).toEqual([
      RESIDENT_LEASE_TERM_SHORT,
      RESIDENT_LEASE_TERM_AIRBNB,
      RESIDENT_LEASE_TERM_LONG,
      RESIDENT_LEASE_TERM_CUSTOM,
    ]);
  });

  it("maps listing canonical labels to resident dropdown values", () => {
    expect(listingLeaseTermToResidentValue("Month-to-Month")).toBe(RESIDENT_LEASE_TERM_LONG);
    expect(listingLeaseTermToResidentValue("12-Month")).toBe(RESIDENT_LEASE_TERM_LONG);
    expect(listingLeaseTermToResidentValue(SHORT_TERM_LEASE_TERM)).toBe(RESIDENT_LEASE_TERM_SHORT);
    expect(listingLeaseTermToResidentValue(AIRBNB_LEASE_TERM)).toBe(RESIDENT_LEASE_TERM_AIRBNB);
  });

  it("keeps custom mode selected even when the text field is empty", () => {
    expect(residentLeaseTermSelectValue("", true, presets)).toBe(RESIDENT_LEASE_TERM_CUSTOM);
  });

  it("detects custom mode from non-preset stored values", () => {
    expect(shouldUseResidentLeaseCustomMode("18 months", presets)).toBe(true);
    expect(shouldUseResidentLeaseCustomMode(RESIDENT_LEASE_TERM_LONG, presets)).toBe(false);
  });

  it("maps resident lease choices to application fields for template generation", () => {
    expect(residentLeaseTermToApplicationFields(RESIDENT_LEASE_TERM_LONG, false, "demo-property-1")).toEqual({
      // "Long-term" is the offered term now (AXI-143); the named lengths are
      // still accepted but a resident's "long term" choice resolves to this.
      leaseTerm: "Long-term",
      rentalType: "standard",
    });
    expect(residentLeaseTermToApplicationFields(RESIDENT_LEASE_TERM_SHORT, false)).toEqual({
      leaseTerm: SHORT_TERM_LEASE_TERM,
      rentalType: "short_term",
    });
    expect(residentLeaseTermToApplicationFields(RESIDENT_LEASE_TERM_AIRBNB, false)).toEqual({
      leaseTerm: AIRBNB_LEASE_TERM,
      rentalType: "airbnb",
    });
    expect(normalizeApplicationLeaseTerm(RESIDENT_LEASE_TERM_LONG, "demo-property-1")).toBe("Long-term");
  });
});
