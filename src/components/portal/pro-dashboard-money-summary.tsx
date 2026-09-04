"use client";

import Link from "next/link";
import { QuickActionRow } from "@/components/ui/quick-action-row";

export function ManagerDashboardMoneySummary({
  totalUnpaidLabel,
  totalPastDueLabel,
  asOfLabel,
  paymentsHref,
  overdueHref,
}: {
  totalUnpaidLabel: string;
  totalPastDueLabel: string;
  asOfLabel: string;
  paymentsHref: string;
  overdueHref?: string;
}) {
  const pastDueHref = overdueHref ?? paymentsHref.replace(/\/pending$/, "/overdue");

  return (
    <div
      className="rounded-xl border border-border bg-card shadow-[var(--shadow-sm)]"
      data-attr="dashboard-money-summary"
    >
      <div className="px-3 pt-3 sm:px-4 sm:pt-4">
        <h3 className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted">Money owed</h3>
      </div>
      <Link
        href={paymentsHref}
        className="grid grid-cols-2 gap-2 px-3 pb-2 pt-1 transition hover:bg-accent/25 sm:gap-3 sm:px-4 sm:pb-3"
      >
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted">Coming in</p>
          <p className="mt-1 text-lg font-bold tabular-nums tracking-tight text-foreground sm:text-xl">
            {totalUnpaidLabel}
          </p>
        </div>
        <div className="min-w-0 border-l border-border pl-3 sm:pl-4">
          <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted">Past due</p>
          <p
            className="mt-1 text-lg font-bold tabular-nums tracking-tight text-[var(--status-overdue-fg)] sm:text-xl"
          >
            {totalPastDueLabel}
          </p>
        </div>
        <p className="col-span-2 text-[10px] font-medium uppercase tracking-[0.08em] text-muted/80">
          As of {asOfLabel}
        </p>
      </Link>
      <QuickActionRow
        className="px-3 pb-3 sm:px-4 sm:pb-4"
        actions={[
          {
            id: "review-pending",
            label: "Review pending",
            href: paymentsHref,
            dataAttr: "dashboard-money-review-pending",
          },
          {
            id: "past-due",
            label: "Past due",
            href: pastDueHref,
            dataAttr: "dashboard-money-past-due",
          },
        ]}
      />
    </div>
  );
}
