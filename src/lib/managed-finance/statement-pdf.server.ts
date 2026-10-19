import "server-only";

import { buildOwnerStatementPdf, type OwnerStatementLine } from "@/lib/reports/export/formal/owner-statement-pdf";
import type { OwnerFinancesView } from "@/lib/managed-finance/finances.server";
import { pacificDayKey } from "@/lib/house-groups/time";

const usd = (cents: number) => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The owner's statement as the existing formal PDF: every ledger row, then the net to the owner for the month. */
export async function buildManagedOwnerStatementPdf(view: OwnerFinancesView, ownerName: string, now: Date = new Date()): Promise<Uint8Array> {
  const s = view.statement;
  const lines: OwnerStatementLine[] = [{ label: "Balance at the start of the month", amount: usd(s.beginningCents) }];
  for (const r of s.rows) {
    const day = r.date.slice(0, 10);
    lines.push({ label: `${day}  ${r.label}${r.propertyLabel ? ` (${r.propertyLabel})` : ""}`, amount: usd(r.amountCents) });
  }
  lines.push({ label: "Balance at the end of the month", amount: usd(s.endingCents), emphasize: true });
  return buildOwnerStatementPdf({
    issueDate: pacificDayKey(now),
    periodFrom: s.fromIso.slice(0, 10),
    periodTo: new Date(Date.parse(s.toIso) - 1).toISOString().slice(0, 10),
    landlordName: "PropLane",
    landlordAddress: "Property management",
    ownerName,
    propertyLabel: view.workspace.name,
    lines,
    distribution: usd(s.totals.netCents),
  });
}
