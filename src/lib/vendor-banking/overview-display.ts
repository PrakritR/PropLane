/**
 * Vendor Finances > Overview, as display rows (portal sweep round 5). The page's own KPI strip
 * already shows Available / Pending / Held / On the way, so the Overview body adds no second tile
 * row: its figures are plain rows, in the SAME money format as that strip (cents), and the service
 * count says "Services", never "Jobs". Presentation only: every amount is the server's integer cents.
 */
import type { VendorFinancesOverview } from "@/lib/vendor-banking/overview";

export type VendorOverviewRow = {
  id: "owed" | "paid-year" | "earned" | "spent" | "profit" | "services";
  label: string;
  value: string;
  tone?: "ok";
};

function monthName(monthKey: string): string {
  const d = new Date(`${monthKey}-15T12:00:00`);
  return Number.isNaN(d.getTime()) ? "This month" : d.toLocaleString("en-US", { month: "long" });
}

export function vendorOverviewRows(
  data: Pick<VendorFinancesOverview, "balance" | "month">,
  formatMoney: (cents: number, currency: string) => string,
): VendorOverviewRow[] {
  const cur = data.balance.currency;
  const month = monthName(data.month.monthKey);
  const money = (cents: number) => formatMoney(cents, cur);
  const ok = (cents: number) => (cents > 0 ? ("ok" as const) : undefined);
  return [
    { id: "owed", label: "Owed to you", value: money(data.balance.owedCents) },
    { id: "paid-year", label: "Paid this year", value: money(data.balance.paidThisYearCents), tone: ok(data.balance.paidThisYearCents) },
    { id: "earned", label: `Earned (${month})`, value: money(data.month.earnedCents), tone: ok(data.month.earnedCents) },
    { id: "spent", label: `Spent (${month})`, value: money(data.month.spentCents) },
    { id: "profit", label: `Profit (${month})`, value: money(data.month.profitCents), tone: ok(data.month.profitCents) },
    { id: "services", label: `Services (${month})`, value: String(data.month.jobs) },
  ];
}
