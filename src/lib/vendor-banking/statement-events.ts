/**
 * Vendor statement event types (vendor-banking-1006): the plain-language type
 * every vendor-ledger line is shown under. Pure and client-safe — the statement
 * route, the CSV, the print page and the list all classify through
 * `vendorStatementEventType`, so a line never has two names.
 *
 * The ledger table stores `kind` + `source`; the richer types are derived from
 * that pair (plus a description prefix for disputes) rather than widening the
 * table's check constraints.
 */
import { PROPLANE_SERVICE_FEE_LABEL } from "@/lib/platform-fees";

export const VENDOR_STATEMENT_EVENT_TYPES = [
  "charge",
  "fee",
  "hold",
  "transfer",
  "withdrawal",
  "instant_fee",
  "refund",
  "dispute",
  "hold_expiry",
  "adjustment",
] as const;
export type VendorStatementEventType = (typeof VENDOR_STATEMENT_EVENT_TYPES)[number];

export const VENDOR_STATEMENT_EVENT_LABELS: Record<VendorStatementEventType, string> = {
  charge: "Charge",
  fee: PROPLANE_SERVICE_FEE_LABEL,
  hold: "Held",
  transfer: "Transfer",
  withdrawal: "Withdrawal",
  instant_fee: "Instant payout fee",
  refund: "Refund",
  dispute: "Dispute",
  hold_expiry: "Returned unclaimed",
  adjustment: "Adjustment",
};

export type VendorStatementEventInput = { kind: string; source: string; description: string };

export function vendorStatementEventType(entry: VendorStatementEventInput): VendorStatementEventType {
  if (entry.source === "hold_expiry") return "hold_expiry";
  if (entry.kind === "platform_fee") return entry.source === "withdrawal" ? "instant_fee" : "fee";
  if (entry.kind === "adjustment" && /^dispute\b/i.test(entry.description.trim())) return "dispute";
  switch (entry.kind) {
    case "charge":
      return "charge";
    case "hold":
      return "hold";
    case "transfer":
      return "transfer";
    case "withdrawal":
      return "withdrawal";
    case "refund":
      return "refund";
    default:
      return "adjustment";
  }
}

export type StatementMonthSummary = {
  /** "2026-09" (UTC). */
  month: string;
  label: string;
  openingCents: number;
  closingCents: number;
  lineCount: number;
};

/** "2026-09" for an ISO timestamp, in UTC (the ledger's month boundary). */
export function statementMonthKey(iso: string): string {
  return iso.slice(0, 7);
}

export function statementMonthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  if (!y || !m) return month;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

/**
 * One summary per calendar month that has activity, newest first, with the
 * opening balance (everything before the month) and closing balance
 * (opening plus the month's lines). Input need not be sorted.
 */
export function summarizeStatementMonths(entries: Array<{ createdAt: string; amountCents: number }>): StatementMonthSummary[] {
  const sorted = [...entries].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  const byMonth = new Map<string, { sum: number; count: number }>();
  for (const entry of sorted) {
    const key = statementMonthKey(entry.createdAt);
    const row = byMonth.get(key) ?? { sum: 0, count: 0 };
    row.sum += entry.amountCents;
    row.count += 1;
    byMonth.set(key, row);
  }
  const months = [...byMonth.keys()].sort();
  let running = 0;
  const out: StatementMonthSummary[] = [];
  for (const month of months) {
    const row = byMonth.get(month)!;
    const openingCents = running;
    running += row.sum;
    out.push({ month, label: statementMonthLabel(month), openingCents, closingCents: running, lineCount: row.count });
  }
  return out.reverse();
}
