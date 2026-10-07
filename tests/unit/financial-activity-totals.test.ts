import { describe, expect, it } from "vitest";
import { summarizeFinancialActivity, summarizeFinancialActivityByProperty } from "@/lib/reports/financial-activity-totals";
const row = (amountCents: number, categoryCode: string, accountType: string, entryType = "payment") => ({ date: "2026-09-02", amountCents, categoryCode, accountType, entryType });
describe("financial activity operating totals", () => {
  it("uses integer cents and subtracts refunds, without deposits or capital", () => {
    const result = summarizeFinancialActivity([
      row(10001, "rent_income", "income"), row(-99, "rent_income", "income", "refund"),
      row(-2501, "maintenance", "expense", "expense"), row(5000, "security_deposit_liability", "liability"),
      row(-500, "security_deposit_liability", "liability", "refund"), row(-90000, "capital_improvement", "expense", "expense"),
      row(-600, "loan_principal", "liability", "expense"), row(9999, "custom_asset", "asset"),
    ]);
    expect(result).toEqual({ heldDepositsCents: 4500, months: { "2026-09": { revenueCents: 9902, expenseCents: 2501, profitCents: 7401, rentCollectedCents: 9902 } } });
  });
  it("does not guess the classification of unknown accounts", () => {
    expect(summarizeFinancialActivity([row(100, "unknown", "unclassified")]).months).toEqual({});
  });
  it("refuses fractional cents and unsafe totals including deposit-only totals", () => {
    expect(() => summarizeFinancialActivity([row(0.1, "rent_income", "income")])).toThrow();
    expect(() => summarizeFinancialActivity([row(Number.MAX_SAFE_INTEGER, "security_deposit", "liability"), row(1, "security_deposit", "liability")])).toThrow();
    expect(() => summarizeFinancialActivity([row(Number.MAX_SAFE_INTEGER, "rent_income", "income"), row(1, "rent_income", "income")])).toThrow();
  });
});

describe("financial activity by property", () => {
  const prow = (amountCents: number, categoryCode: string, accountType: string, propertyId: string | null, property: string | null, date = "2026-09-02") => ({ date, amountCents, categoryCode, accountType, propertyId, property });
  it("groups the same operating rows per property for the month, never deposits or capital", () => {
    const result = summarizeFinancialActivityByProperty([
      prow(120000, "rent_income", "income", "p1", "61 Willow Court"), prow(-31000, "maintenance", "expense", "p1", "61 Willow Court"),
      prow(90000, "rent_income", "income", "p2", "14 Cedar Lane"), prow(5000, "security_deposit_liability", "liability", "p2", "14 Cedar Lane"),
      prow(-90000, "capital_improvement", "expense", "p2", "14 Cedar Lane"), prow(50000, "rent_income", "income", "p2", "14 Cedar Lane", "2026-08-30"),
      prow(2500, "other_income", "income", null, null),
    ], "2026-09");
    expect(result).toEqual([
      { key: "p2", label: "14 Cedar Lane", inCents: 90000, outCents: 0 },
      { key: "p1", label: "61 Willow Court", inCents: 120000, outCents: 31000 },
      { key: "", label: "Portfolio", inCents: 2500, outCents: 0 },
    ].sort((a, b) => a.label.localeCompare(b.label)));
  });
  it("agrees with the month totals the summary reports", () => {
    const rows = [prow(100, "rent_income", "income", "p1", "A"), prow(-40, "maintenance", "expense", "p2", "B")];
    const month = summarizeFinancialActivity(rows).months["2026-09"]!;
    const per = summarizeFinancialActivityByProperty(rows, "2026-09");
    expect(per.reduce((n, p) => n + p.inCents, 0)).toBe(month.revenueCents);
    expect(per.reduce((n, p) => n + p.outCents, 0)).toBe(month.expenseCents);
  });
});
