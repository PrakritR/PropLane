import { readDateCell } from "@/lib/sales-workbook-roster";
import { financialFactSchema, type FinancialFact } from "./model";

/** Explicit reviewed mappings only. Adjacent roster/P&L blocks have no implied
 * relationship. Stable transaction keys must survive row insertion or sorting. */
export type SalesFinancialBlock = {
  propertyKey: string; sheet: string; firstRow: number;
  rows: unknown[][];
  columns: { date: number; amount: number; description: number; recordKey: number };
  kind: "income" | "expense"; categoryCode: string;
  amountSign: "positive" | "negative";
};
export function prepareSalesFinancialBlock(block: SalesFinancialBlock) {
  if (!Number.isInteger(block.firstRow) || block.firstRow < 1 || block.rows.length > 5000 || Object.values(block.columns).some(c => !Number.isInteger(c) || c < 0 || c > 1000)) throw new Error("Use bounded rows and zero-based column indexes");
  if (!["income", "expense"].includes(block.kind) || !["positive", "negative"].includes(block.amountSign)) throw new Error("Explicit transaction kind and sign mapping required");
  const facts: FinancialFact[] = [], unresolved: { source: FinancialFact["source"]; propertyKey: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const [offset, row] of block.rows.entries()) {
    const cell = (column: keyof typeof block.columns) => String(row[block.columns[column]] ?? "").trim();
    if (Object.keys(block.columns).every(c => !cell(c as keyof typeof block.columns))) continue;
    const source = { sheet: block.sheet, range: `${block.firstRow + offset}:${block.firstRow + offset}`, recordKey: cell("recordKey") };
    const rawDate = cell("date"), amount = cell("amount").replace(/[$,]/g, "");
    const validAmount = /^-?\d+(\.\d{1,2})?$/.test(amount);
    const signedAmount = Number(amount) * (block.amountSign === "negative" ? -1 : 1);
    const candidate = financialFactSchema.safeParse({ source, kind: block.kind, categoryCode: block.categoryCode, date: /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : readDateCell(rawDate).iso, amountCents: validAmount ? Math.round(signedAmount * 100) : null, description: cell("description") });
    if (!candidate.success || seen.has(source.recordKey)) {
      if (seen.has(source.recordKey)) { const index = facts.findIndex(f => f.source.recordKey === source.recordKey); if (index >= 0) facts.splice(index, 1); }
      unresolved.push({ propertyKey: block.propertyKey, source: { ...source, recordKey: source.recordKey || `unresolved-row-${block.firstRow + offset}` }, reason: seen.has(source.recordKey) ? "Duplicate stable transaction key" : "Review transaction date, signed amount, description and stable key; summaries and notes are not transactions" });
    } else { seen.add(source.recordKey); facts.push(candidate.data); }
  }
  return { facts, unresolved };
}
