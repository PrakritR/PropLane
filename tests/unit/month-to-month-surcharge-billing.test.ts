import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/listing-fee-term-toggles", () => ({ listingPresetFeeAmountIfEnabled: (_s: unknown, id: string) => (id === "mtm_surcharge" ? 75 : 0) }));
vi.mock("@/lib/listing-fees", () => ({ listingPresetFeeAmount: () => 0 }));
vi.mock("@/lib/listing-fee-scope", () => ({ listingPresetFeeAppliesToLeaseType: () => true }));
vi.mock("@/lib/rental-application/lease-dates", () => ({ isCustomCalendarLease: () => false }));

import { MONTH_TO_MONTH_SURCHARGE_FEE_ID, recurringMonthlyFeesForLease } from "@/lib/custom-lease-billing";

describe("month-to-month surcharge bills monthly (captain, Oct 3)", () => {
  const sub = {} as never;
  it("bills on a Month-to-Month lease", () => {
    const fees = recurringMonthlyFeesForLease(sub, [], { leaseTerm: "Month-to-Month" });
    expect(fees).toEqual([{ id: MONTH_TO_MONTH_SURCHARGE_FEE_ID, label: "Month-to-month surcharge", amount: 75 }]);
  });
  it("never on another term or a short stay", () => {
    expect(recurringMonthlyFeesForLease(sub, [], { leaseTerm: "Long-term" })).toEqual([]);
    expect(recurringMonthlyFeesForLease(sub, [], { leaseTerm: "Month-to-Month", rentalType: "short_term" })).toEqual([]);
  });
  it("never twice", () => {
    const fees = recurringMonthlyFeesForLease(sub, [{ id: MONTH_TO_MONTH_SURCHARGE_FEE_ID, label: "x", amount: 75 }], { leaseTerm: "Month-to-Month" });
    expect(fees.filter((f) => f.id === MONTH_TO_MONTH_SURCHARGE_FEE_ID)).toHaveLength(1);
  });
});
