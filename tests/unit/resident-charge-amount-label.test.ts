import { describe, expect, it } from "vitest";
import type { HouseholdCharge } from "@/lib/household-charges";
import { residentChargeAmountLabel } from "@/lib/household-charges";

const base = { id: "c", amountLabel: "$544.00", balanceLabel: "$544.00" } as HouseholdCharge;

describe("residentChargeAmountLabel", () => {
  it("shows what is still owed on an unpaid charge", () => {
    expect(residentChargeAmountLabel({ ...base, status: "pending", balanceLabel: "$300.00" })).toBe("$300.00");
  });

  it("shows the recorded paid amount, never the $0.00 balance, on a paid charge", () => {
    expect(residentChargeAmountLabel({ ...base, status: "paid", balanceLabel: "$0.00", paidAmountCents: 54400 })).toBe("$544.00");
    expect(residentChargeAmountLabel({ ...base, status: "paid", balanceLabel: "$0.00", paidAmountCents: 123456 })).toBe("$1,234.56");
  });

  it("falls back to the charge's own amount when a paid receipt carries no paid amount", () => {
    expect(residentChargeAmountLabel({ ...base, status: "paid", balanceLabel: "$0.00" })).toBe("$544.00");
    expect(residentChargeAmountLabel({ ...base, status: "paid", balanceLabel: "$0.00", paidAmountCents: 0 })).toBe("$544.00");
  });
});
