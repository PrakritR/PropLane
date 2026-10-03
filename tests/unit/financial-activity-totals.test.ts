import { describe, expect, it } from "vitest";
import { summarizeFinancialActivity } from "@/lib/reports/financial-activity-totals";
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
