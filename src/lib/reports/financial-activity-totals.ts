import type { ReportRow } from "./types";

export function summarizeFinancialActivity(rows: ReportRow[]) {
  const months = new Map<string, { revenueCents: number; expenseCents: number; profitCents: number; rentCollectedCents: number }>();
  let heldDepositsCents = 0;
  for (const row of rows) {
    const amount = Number(row.amountCents);
    if (!Number.isSafeInteger(amount)) throw new Error("Invalid ledger amount.");
    const category = String(row.categoryCode ?? "");
    if (/^(security_deposit|holding_deposit|security_deposit_liability)$/.test(category)) {
      heldDepositsCents += amount;
      if (!Number.isSafeInteger(heldDepositsCents)) throw new Error("Deposit total exceeds supported precision.");
      continue;
    }
    // Capital and loan principal are cash movements, never operating expenses.
    if (/^(capital_improvement|construction|remodel|purchase|down_payment|sale_proceeds|cashback|principal|loan_principal|mortgage_principal|loan_payoff)$/.test(category)) continue;
    if (row.accountType !== "income" && row.accountType !== "expense") continue;
    const month = String(row.date).slice(0, 7);
    const totals = months.get(month) ?? { revenueCents: 0, expenseCents: 0, profitCents: 0, rentCollectedCents: 0 };
    if (row.accountType === "expense") totals.expenseCents -= amount;
    else totals.revenueCents += amount;
    if (category === "rent_income") totals.rentCollectedCents += amount;
    totals.profitCents = totals.revenueCents - totals.expenseCents;
    if (![totals.revenueCents, totals.expenseCents, totals.profitCents, heldDepositsCents].every(Number.isSafeInteger)) throw new Error("Ledger total exceeds supported precision.");
    months.set(month, totals);
  }
  return { heldDepositsCents, months: Object.fromEntries(months) };
}
