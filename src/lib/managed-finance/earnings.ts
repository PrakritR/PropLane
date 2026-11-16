/**
 * A person's Earnings (the Airbnb host "Earnings" page, on PropLane's own ledger). Pure folds over one party's payable lines: the
 * per-house breakdown and the CSV. Nothing recomputes money; it labels what the ledger posted. Signed from the person's side
 * (a credit to them is positive).
 */

import type { StatementLine, StatementRow } from "@/lib/managed-finance/statement";

export type HouseEarning = { propertyId: string | null; cents: number };

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};
const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** Net earnings per house from a party's payable lines: rent shares, splits, refunds and vendor charges; withdrawals are not earnings. */
export function earningsByHouse(lines: readonly StatementLine[]): HouseEarning[] {
  const byHouse = new Map<string, number>();
  const add = (propertyId: string, cents: number) => byHouse.set(propertyId, (byHouse.get(propertyId) ?? 0) + cents);
  for (const line of lines) {
    const credit = -line.amountCents;
    const d = line.detail;
    switch (line.kind) {
      case "rent_capture": {
        const charges = Array.isArray(d.charges) ? (d.charges as Array<Record<string, unknown>>) : [];
        for (const c of charges) add(text(c.property_id), num(c.owner_cents));
        break;
      }
      case "split_allocation":
      case "split_reversal":
      case "refund":
      case "vendor_bill":
        add(text(d.property_id), credit);
        break;
      default:
    }
  }
  return [...byHouse.entries()].map(([propertyId, cents]) => ({ propertyId: propertyId || null, cents })).filter((h) => h.cents !== 0).sort((a, b) => b.cents - a.cents);
}

function csvCell(value: string | number | null | undefined): string {
  const raw = value === null || value === undefined ? "" : String(value);
  // A spreadsheet formula must never run from a label: neutralise a leading = + - @ in text (amounts are written as plain numbers).
  const safe = typeof value === "string" && /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** The earnings report as CSV: one row per statement row, amounts in dollars from the person's side. */
export function earningsCsv(rows: ReadonlyArray<StatementRow & { workspaceName?: string | null; propertyLabel?: string | null }>): string {
  const header = ["Date", "Type", "Description", "Workspace", "House", "Amount (USD)"];
  const lines = rows.map((r) =>
    [
      csvCell(r.date.slice(0, 10)), csvCell(r.kind), csvCell(r.label), csvCell(r.workspaceName ?? ""), csvCell(r.propertyLabel ?? ""),
      (r.amountCents / 100).toFixed(2),
    ].join(","),
  );
  return [header.join(","), ...lines].join("\r\n") + "\r\n";
}
