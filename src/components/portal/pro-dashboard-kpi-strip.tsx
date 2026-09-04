"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";

export type DashboardKpiChip = {
  id: string;
  label: string;
  value: string | number;
  href: string;
  badge?: string;
  alert?: boolean;
  dataAttr?: string;
};

export function ManagerDashboardKpiStrip({ items }: { items: DashboardKpiChip[] }) {
  if (items.length === 0) return null;

  return (
    <div
      className="flex gap-2 overflow-x-auto pb-0.5 [-ms-overflow-style:none] [scrollbar-width:none] snap-x snap-mandatory scroll-px-1 [&::-webkit-scrollbar]:hidden"
      data-slot="dashboard-kpi-strip"
    >
      {items.map((item) => (
        <Link
          key={item.id}
          href={item.href}
          data-attr={item.dataAttr}
          className={cn(
            "flex min-h-[4.5rem] min-w-[7.5rem] shrink-0 snap-start flex-col justify-between rounded-xl border border-border bg-card px-3 py-2.5 shadow-[var(--shadow-sm)] transition hover:border-primary/25",
            item.alert && "border-[color-mix(in_srgb,var(--status-pending-bg)_50%,var(--border))]",
          )}
        >
          <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-muted leading-tight">
            {item.label}
          </span>
          <div className="flex items-end justify-between gap-1">
            <span className="text-xl font-bold tabular-nums tracking-tight text-foreground">
              {item.value}
            </span>
            {item.badge ? (
              <span className="rounded-full bg-primary/12 px-1.5 py-0.5 text-[9px] font-bold text-primary">
                {item.badge}
              </span>
            ) : null}
          </div>
        </Link>
      ))}
    </div>
  );
}
