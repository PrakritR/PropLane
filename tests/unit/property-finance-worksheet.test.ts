import { describe, expect, it } from "vitest";
import { checkedSum, financialGroup, parseWorksheetUpdate, propertyCashGroups } from "@/lib/reports/property-worksheet";
import { buildRentDueSummary } from "@/lib/reports/rent-due";
import type { HouseholdCharge } from "@/lib/household-charges";
describe("Property finance source data", () => {
  it("keeps deposits, principal and capital separate from operating costs", () => {
    expect(financialGroup({ categoryCode: "security_deposit_liability", accountType: "liability" })).toBe("Deposits");
    expect(financialGroup({ categoryCode: "capital_improvement", accountType: "expense" })).toBe("Capital movements");
    expect(financialGroup({ categoryCode: "mortgage_principal" })).toBe("Loan principal");
    const groups = propertyCashGroups([{ id: "ledger-a", date: "2026-09-01", category: "Rent", categoryCode: "rent_income", accountType: "income", amountCents: 10001 }, { id: "ledger-b", date: "2026-10-01", category: "Rent", categoryCode: "rent_income", accountType: "income", amountCents: -99 }]);
    expect(groups.Revenue.Rent.amountCents).toBe(9902);
    expect(groups.Revenue.Rent.months["2026-09"].amountCents).toBe(10001);
    expect(groups.Revenue.Rent.rows.map(r => r.id)).toEqual(["ledger-a", "ledger-b"]);
  });
  it("accepts only signed integer source cents and nonnegative capital cents", () => {
    expect(parseWorksheetUpdate({ kind: "reported", period: "2026-09", amountCents: -1200, convention: "expense_positive" }).path).toBe("reported.2026-09");
    expect(() => parseWorksheetUpdate({ kind: "capital", values: { purchase: -1 } })).toThrow();
    expect(() => parseWorksheetUpdate({ kind: "reported", period: "2026-13", amountCents: 10, convention: "income_positive" })).toThrow();
    expect(() => checkedSum([Number.MAX_SAFE_INTEGER, 1])).toThrow();
  });
  it("uses charges due in the selected month and excludes cancelled charges", () => {
    const base = { id: "rent-a", kind: "rent", propertyId: "property", propertyLabel: "House", residentEmail: "a@example.test", status: "partially_paid", amountLabel: "$100.01", balanceLabel: "$50.00", paidAmountCents: 5001, rentMonth: "2026-09", dueDay: 1 } as HouseholdCharge;
    const result = buildRentDueSummary([base, { ...base, id: "cancelled", residentEmail: "b@example.test", status: "cancelled" }, { ...base, id: "other-month", rentMonth: "2026-10" }], "2026-09");
    expect(result.dueCents).toBe(10001); expect(result.collectedCents).toBe(5001); expect(result.percent).toBe(50);
    expect(result.rooms["House · Unassigned room"].rent.outstandingCents).toBe(5000);
  });
});
