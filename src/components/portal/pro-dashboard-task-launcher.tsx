"use client";

import {
  Calendar,
  ChevronRight,
  ClipboardList,
  DollarSign,
  FileSignature,
  Home,
  Megaphone,
  MessageSquare,
  PlusCircle,
  Receipt,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";

export type DashboardTaskItem = {
  id: string;
  label: string;
  description?: string;
  href: string;
  count?: number;
  urgent?: boolean;
  icon: LucideIcon;
  dataAttr?: string;
};

function TaskLauncherRow({
  item,
  tinted,
}: {
  item: DashboardTaskItem;
  tinted?: boolean;
}) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      data-attr={item.dataAttr}
      className={cn(
        "group portal-pressable flex min-h-[52px] items-center gap-3 rounded-xl border border-border px-3.5 py-2.5 transition-colors",
        "hover:border-primary/30 hover:bg-accent/40",
        tinted && "border-[color-mix(in_srgb,var(--status-pending-bg)_55%,var(--border))] bg-[color-mix(in_srgb,var(--status-pending-bg)_28%,var(--card))]",
        item.urgent &&
          "border-[color-mix(in_srgb,var(--status-overdue-bg)_55%,var(--border))] bg-[color-mix(in_srgb,var(--status-overdue-bg)_22%,var(--card))]",
      )}
    >
      <span
        className={cn(
          "grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent/50 text-foreground",
          item.urgent && "bg-[color-mix(in_srgb,var(--status-overdue-bg)_65%,var(--card))] text-[var(--status-overdue-fg)]",
        )}
        aria-hidden
      >
        <Icon className="h-[18px] w-[18px]" strokeWidth={2} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <span className="truncate">{item.label}</span>
        </span>
        {item.description ? (
          <span className="mt-0.5 block truncate text-xs text-muted">{item.description}</span>
        ) : null}
      </span>
      <ChevronRight
        className="h-4 w-4 shrink-0 text-muted/50 transition group-hover:text-muted"
        aria-hidden
      />
    </Link>
  );
}

export function ManagerDashboardTaskLauncher({
  ranked,
  more,
}: {
  ranked: DashboardTaskItem[];
  more: DashboardTaskItem[];
}) {
  return (
    <section className="space-y-2" data-slot="dashboard-task-launcher" aria-label="Quick actions">
      <h2 className="text-xs font-bold uppercase tracking-[0.12em] text-muted">What you can do</h2>
      <div className="space-y-1.5">
        {ranked.map((item) => (
          <TaskLauncherRow key={item.id} item={item} tinted={Boolean(item.count && item.count > 0)} />
        ))}
      </div>
      {more.length > 0 ? (
        <>
          <p className="pt-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted/80">
            More actions
          </p>
          <div className="space-y-1.5">
            {more.map((item) => (
              <TaskLauncherRow key={item.id} item={item} />
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}

export const DASHBOARD_TASK_ICONS = {
  applications: ClipboardList,
  leases: FileSignature,
  payments: DollarSign,
  services: Wrench,
  messages: MessageSquare,
  calendar: Calendar,
  promotion: Megaphone,
  properties: Home,
  charge: PlusCircle,
  expense: Receipt,
} as const;
