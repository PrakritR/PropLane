/**
 * Charges suggested from the monthly rent.
 *
 * These are SUGGESTIONS shown in empty fields, never silent writes. A deposit is
 * capped by law in places PropLane operates, and setting a weekly or daily rate
 * changes how every rent charge is billed — so both must stay explicit acts.
 */
import { describe, expect, it } from "vitest";
import { derivedRoomCharges, isUnsetCharge, suggestionPlaceholder } from "@/lib/listing-room-derived-pricing";

describe("derivedRoomCharges", () => {
  it("annualizes the weekly rate rather than dividing by four", () => {
    // $1,050/mo is $12,600/yr, which is $242/wk — not $262, which is what
    // "divide by 4" gives and which overstates a year by nearly a month.
    expect(derivedRoomCharges(1050)!.weeklyRent).toBe(242);
  });

  it("uses the same 30-day month the rest of the pricing code uses", () => {
    expect(derivedRoomCharges(1050)!.dailyRent).toBe(35);
  });

  it("suggests one month's rent as the deposit and half as the move-in fee", () => {
    const d = derivedRoomCharges(1200)!;
    expect(d.securityDeposit).toBe(1200);
    expect(d.moveInFee).toBe(600);
  });

  it("suggests nothing when there is no rent, rather than a row of zeroes", () => {
    // "$0 suggested" reads as a real answer; absence reads as absence.
    expect(derivedRoomCharges(0)).toBeNull();
    expect(derivedRoomCharges(-5)).toBeNull();
    expect(derivedRoomCharges(Number.NaN)).toBeNull();
  });

  it("rounds to whole dollars so a placeholder never shows fractions of a cent", () => {
    const d = derivedRoomCharges(1333)!;
    expect(Number.isInteger(d.weeklyRent)).toBe(true);
    expect(Number.isInteger(d.dailyRent)).toBe(true);
    expect(Number.isInteger(d.moveInFee)).toBe(true);
  });
});

describe("isUnsetCharge", () => {
  it("treats blanks, zero and non-numeric text as unset", () => {
    expect(isUnsetCharge("")).toBe(true);
    expect(isUnsetCharge("   ")).toBe(true);
    expect(isUnsetCharge(0)).toBe(true);
    expect(isUnsetCharge(undefined)).toBe(true);
    expect(isUnsetCharge("$")).toBe(true);
  });

  it("treats a real figure as set, with or without a currency symbol", () => {
    expect(isUnsetCharge("500")).toBe(false);
    expect(isUnsetCharge("$500")).toBe(false);
    expect(isUnsetCharge(500)).toBe(false);
  });
});

describe("suggestionPlaceholder", () => {
  it("is empty for a missing or zero suggestion", () => {
    expect(suggestionPlaceholder(undefined)).toBe("");
    expect(suggestionPlaceholder(0)).toBe("");
  });
  it("renders a positive suggestion as plain digits", () => {
    expect(suggestionPlaceholder(242)).toBe("242");
  });
});
