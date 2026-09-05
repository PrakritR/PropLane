/**
 * "Variable (by usage)" utilities.
 *
 * A fourth utilities model that is manager-billed like "Fixed amount", but
 * whose amount follows actual usage. The stored number is an ESTIMATE, and the
 * whole point of the model is that it must never be charged as though it were
 * a measured bill: the manager raises the real charge once usage is known.
 */
import { describe, expect, it } from "vitest";
import {
  LONG_TERM_UTILITIES_PAYMENT_OPTIONS,
  aggregateBillableUtilitiesEstimate,
  formatUtilitiesListingLine,
  longTermUtilitiesEstimateRequired,
  longTermUtilitiesPickerValue,
  normalizeUtilitiesPaymentModel,
  utilitiesAmountFieldNoun,
  utilitiesAmountIsFixedCharge,
  utilitiesBillableMonthlyAmount,
  utilitiesListingSummaryLabel,
} from "@/lib/listing-utilities-payment";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";

function subWithRooms(rooms: { name: string; model: string; estimate: string }[]) {
  const base = createDefaultListingSubmission();
  return {
    ...base,
    rentalStyle: "rooms",
    rooms: rooms.map((r, i) => ({
      ...(base.rooms[0] ?? {}),
      id: `room-${i}`,
      name: r.name,
      utilitiesPaymentModel: r.model,
      utilitiesEstimate: r.estimate,
    })),
  } as typeof base;
}

describe("the option exists and survives a round trip", () => {
  it("is offered in the long-term picker", () => {
    const ids = LONG_TERM_UTILITIES_PAYMENT_OPTIONS.map((o) => o.id);
    expect(ids).toContain("variable");
  });

  it("normalizes and picks back as itself, not as Fixed amount", () => {
    expect(normalizeUtilitiesPaymentModel("variable")).toBe("variable");
    expect(longTermUtilitiesPickerValue("variable")).toBe("variable");
  });

  it("still reads an unknown stored value as Fixed amount", () => {
    expect(normalizeUtilitiesPaymentModel("metered")).toBe("manager_billed");
    expect(normalizeUtilitiesPaymentModel(undefined)).toBe("manager_billed");
  });
});

describe("the amount is an estimate, never a charge", () => {
  it("is not a fixed charge, unlike Fixed amount", () => {
    expect(utilitiesAmountIsFixedCharge("manager_billed")).toBe(true);
    expect(utilitiesAmountIsFixedCharge("variable")).toBe(false);
    expect(utilitiesAmountIsFixedCharge("tenant_direct")).toBe(false);
    expect(utilitiesAmountIsFixedCharge("included_in_rent")).toBe(false);
  });

  it("bills nothing on a recurring schedule", () => {
    const fixed = subWithRooms([{ name: "A", model: "manager_billed", estimate: "200" }]);
    const variable = subWithRooms([{ name: "A", model: "variable", estimate: "200" }]);
    expect(utilitiesBillableMonthlyAmount(fixed, fixed.rooms[0])).toBe(200);
    expect(utilitiesBillableMonthlyAmount(variable, variable.rooms[0])).toBe(0);
    expect(aggregateBillableUtilitiesEstimate(variable)).toBe(0);
  });

  it("still shows an amount input, so a prospect sees a typical figure", () => {
    expect(longTermUtilitiesEstimateRequired("variable")).toBe(true);
    expect(longTermUtilitiesEstimateRequired("manager_billed")).toBe(true);
    expect(longTermUtilitiesEstimateRequired("tenant_direct")).toBe(false);
    expect(longTermUtilitiesEstimateRequired("included_in_rent")).toBe(false);
  });

  it("names that input as an estimate rather than an amount", () => {
    expect(utilitiesAmountFieldNoun("variable")).toMatch(/estimat/i);
    expect(utilitiesAmountFieldNoun("manager_billed")).not.toMatch(/estimat/i);
  });
});

describe("what a prospect reads", () => {
  it("never renders as a flat monthly price", () => {
    const line = formatUtilitiesListingLine("variable", "200");
    expect(line).toMatch(/usage/i);
    // The fixed-amount sentence is "$200/mo est." — a prospect reading that
    // expects that exact bill every month.
    expect(line).not.toBe(formatUtilitiesListingLine("manager_billed", "200"));
  });

  it("says so even with no estimate set", () => {
    expect(formatUtilitiesListingLine("variable", "")).toMatch(/usage/i);
  });

  it("summarises a whole listing by usage, with a typical range", () => {
    const sub = subWithRooms([
      { name: "A", model: "variable", estimate: "150" },
      { name: "B", model: "variable", estimate: "250" },
    ]);
    const label = utilitiesListingSummaryLabel(sub);
    expect(label).toMatch(/usage/i);
    expect(label).toMatch(/150/);
    expect(label).toMatch(/250/);
  });
});

describe("rooms that disagree are still not a billing fact", () => {
  it("bills nothing when one room is fixed and another is variable", () => {
    const sub = subWithRooms([
      { name: "A", model: "manager_billed", estimate: "200" },
      { name: "B", model: "variable", estimate: "200" },
    ]);
    expect(aggregateBillableUtilitiesEstimate(sub)).toBe(0);
  });
});
