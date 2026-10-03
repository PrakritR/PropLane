import type { ReportRow } from "./types";
export const CAPITAL_FIELDS = ["purchase", "downPayment", "construction", "remodel", "loanPayoff", "cashback", "saleProceeds"] as const;
export type PropertyWorksheet = { capital?: Partial<Record<(typeof CAPITAL_FIELDS)[number], number>>; reported?: Record<string, { amountCents: number | null; convention: "income_positive" | "expense_positive" }> };
export function checkedSum(values: number[]): number {
  return values.reduce((total, value) => { if (!Number.isSafeInteger(value) || !Number.isSafeInteger(total + value)) throw new Error("Invalid financial amount."); return total + value; }, 0);
}
export function financialGroup(row: ReportRow): string {
  const category = String(row.categoryCode ?? "");
  if (/deposit/.test(category)) return "Deposits";
  if (/^(principal|loan_principal|mortgage_principal|loan_payoff)$/.test(category)) return "Loan principal";
  if (/^(capital_improvement|construction|remodel|purchase|down_payment|sale_proceeds|cashback)$/.test(category)) return "Capital movements";
  if (category === "mortgage") return "Mortgage · unsplit";
  if (row.accountType === "income") return "Revenue";
  if (row.accountType === "expense") return "Expenses";
  return "Unclassified";
}
export function propertyCashGroups(rows: ReportRow[]) {
  const groups: Record<string, Record<string, { amountCents: number; rows: ReportRow[]; months: Record<string, { amountCents: number; rows: ReportRow[] }> }>> = {};
  for (const row of rows) {
    const group = financialGroup(row), category = String(row.category || row.categoryCode || "Unclassified");
    groups[group] ??= {}; groups[group][category] ??= { amountCents: 0, rows: [], months: {} };
    const bucket = groups[group][category]; bucket.amountCents = checkedSum([bucket.amountCents, Number(row.amountCents)]); bucket.rows.push(row);
    const month = String(row.date).slice(0, 7); bucket.months[month] ??= { amountCents: 0, rows: [] };
    bucket.months[month].amountCents = checkedSum([bucket.months[month].amountCents, Number(row.amountCents)]); bucket.months[month].rows.push(row);
  }
  return groups;
}
export function parseWorksheetUpdate(body: Record<string, unknown>) {
  if (body.kind === "capital") {
    const raw = body.values as Record<string, unknown>;
    if (!raw || typeof raw !== "object") throw new Error("Capital amounts required.");
    const value: Record<string, number> = {};
    for (const key of CAPITAL_FIELDS) {
      if (raw[key] === undefined || raw[key] === null) continue;
      if (!Number.isSafeInteger(raw[key]) || Number(raw[key]) < 0) throw new Error("Capital amounts must be nonnegative integer cents.");
      value[key] = Number(raw[key]);
    }
    return { path: "capital", value };
  }
  if (body.kind !== "reported" || !/^\d{4}(-(?:0[1-9]|1[0-2]))?$/.test(String(body.period))) throw new Error("Valid report period required.");
  if (body.amountCents !== null && !Number.isSafeInteger(body.amountCents)) throw new Error("Source amount must be integer cents.");
  if (!["income_positive", "expense_positive"].includes(String(body.convention))) throw new Error("Source convention required.");
  return { path: `reported.${body.period}`, value: { amountCents: body.amountCents, convention: body.convention } };
}
