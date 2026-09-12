"use client";

import Link from "next/link";
import {
  ArrowRight,
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
  return (
    <div className="flex flex-col gap-6 pb-6" data-attr="finances-reports">
      {REPORT_GROUPS.map((group) => (
        <section key={group.label} className="flex flex-col gap-2.5">
          <h2 className="px-0.5 text-[11px] font-bold uppercase tracking-[0.12em] text-muted/80">{group.label}</h2>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {group.reports.map((report) => {
              const Icon = report.icon;
              return (
                <Link
                  key={report.id}
                  href={`${basePath}/financials/${report.id}`}
                  data-attr={`finances-report-${report.id}`}
                  className="group flex min-w-0 items-start gap-3 rounded-2xl border border-border bg-card px-4 py-3.5 shadow-sm transition hover:border-primary/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                >
                  <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                    <Icon className="size-4" strokeWidth={1.75} aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1 text-[14px] font-semibold text-foreground">
                      {report.label}
                      <ArrowRight className="size-3.5 text-muted opacity-0 transition group-hover:opacity-100" aria-hidden />
                    </span>
                    <span className="mt-0.5 block text-[12.5px] leading-snug text-muted">{report.description}</span>
                  </span>
                </Link>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
