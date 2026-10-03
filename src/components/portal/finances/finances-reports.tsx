"use client";

import Link from "next/link";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import {
  MoreHorizontal,
  BookOpen,
  Building2,
  ClipboardList,
  FileSpreadsheet,
  Landmark,
  PiggyBank,
  Receipt,
  Scale,
  ShieldCheck,
  Stethoscope,
  TrendingUp,
  Wallet,
  type LucideIcon,
} from "lucide-react";

/**
 * Finances · Reports — one door to every statement the ledger can produce.
 * The report tabs themselves are unchanged; this page names them, says what
 * each answers, and groups them so a manager looking for "what do I send my
 * owner" or "what goes on Schedule E" finds it without reading fourteen tabs.
 */

type ReportCard = {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
};

const REPORT_GROUPS: Array<{ label: string; reports: ReportCard[] }> = [
  { label: "Reports", reports: [
    { id: "income-statement", label: "Profit and loss", description: "", icon: TrendingUp },
    { id: "profitability", label: "By property", description: "", icon: Building2 },
    { id: "financial-activity", label: "Ledger (CSV)", description: "", icon: BookOpen },
  ] },
  {
    label: "Statements",
    reports: [
      { id: "cash-flow-statement", label: "Cash flow", description: "Money in and out by month, with the net line.", icon: TrendingUp },
      { id: "trial-balance", label: "Trial balance", description: "Every account's debits and credits, always balanced.", icon: Scale },
      { id: "balance-sheet", label: "Balance sheet", description: "Assets, liabilities and equity as of today.", icon: Landmark },
      { id: "general-ledger", label: "General ledger", description: "Every journal line, exportable to QuickBooks.", icon: BookOpen },
    ],
  },
  {
    label: "Owners and tax",
    reports: [
      { id: "owner-statement", label: "Owner statement", description: "Per-property income and expenses, ready to send.", icon: Building2 },
      { id: "owner-distributions", label: "Distributions", description: "What has been paid out to owners and when.", icon: Wallet },
      { id: "budget-vs-actual", label: "Budget vs actual", description: "Planned against booked, category by category.", icon: ClipboardList },
    ],
  },
  {
    label: "Money held and owed",
    reports: [
      { id: "security-deposits", label: "Deposits", description: "Deposits held per resident, and returns due.", icon: PiggyBank },
      { id: "trust-account-balance", label: "Trust account", description: "The trust balance against deposits held.", icon: ShieldCheck },
      { id: "bills", label: "Bills", description: "Vendor bills waiting to be paid.", icon: Receipt },
      { id: "ap-aging", label: "AP aging", description: "How long unpaid bills have been unpaid.", icon: FileSpreadsheet },
    ],
  },
  {
    label: "Bank and checks",
    reports: [
      { id: "payout-history", label: "Payout history", description: "Stripe payouts to your bank, by date.", icon: Landmark },
      { id: "bank-reconciliation", label: "Bank reconciliation", description: "Match statements to the ledger.", icon: Scale },
      { id: "financial-diagnostics", label: "Diagnostics", description: "Rows that do not add up, and why.", icon: Stethoscope },
    ],
  },
];

export const FINANCES_REPORT_TAB_IDS = new Set(REPORT_GROUPS.flatMap((g) => g.reports.map((r) => r.id)));

export function ManagerFinancesReports({ basePath }: { basePath: string }) {
  const specialPanels = new Set(["bills", "security-deposits", "owner-distributions", "bank-reconciliation"]);
  const reportIds: Record<string, string> = { "income-statement": "monthly-profit-loss", "security-deposits": "trust-account-balance", bills: "ap-aging", "owner-distributions": "owner-statement", "bank-reconciliation": "general-ledger" };
  return <div className="divide-y divide-border pb-6" data-attr="finances-reports">{REPORT_GROUPS.flatMap(g => g.reports).map(report => {
    const Icon = report.icon;
    const href = report.id === "financial-activity" ? `${basePath}/financials/activity` : report.id === "security-deposits" ? `${basePath}/financials/activity?category=deposits` : `${basePath}/financials/${report.id}`;
    const exportId = reportIds[report.id] ?? report.id;
    const download = (format: string) => report.id === "profitability" ? `/api/reports/property-worksheet?format=${format}` : specialPanels.has(report.id) ? `/api/reports/operational-export?kind=${report.id}&format=${format}` : `/api/reports/${exportId}/export?format=${format}`;
    return <div key={report.id} className="flex items-center gap-3 py-4" data-attr={`finances-report-${report.id}`}>
      <Icon className="size-5 text-primary" aria-hidden />
      <Link href={href} className="min-w-0 flex-1 font-medium">{report.label}</Link>
      <DropdownMenu modal={false}><DropdownMenuTrigger aria-label={`${report.label} actions`} className="p-3"><MoreHorizontal className="size-5" /></DropdownMenuTrigger><DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => window.location.assign(href)}>View</DropdownMenuItem>
        {["csv", "pdf"].map(format => <DropdownMenuItem key={format} onSelect={() => window.location.assign(download(format))}>Download {format.toUpperCase()}</DropdownMenuItem>)}
      </DropdownMenuContent></DropdownMenu>
    </div>;
  })}</div>;
}
