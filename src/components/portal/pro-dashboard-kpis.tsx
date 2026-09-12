"use client";

/**
 * The head of the manager dashboard after the Mobbin polish: four KPI cards
 * that each carry a direction and eight bars of history, a period selector
 * that sets their baseline, and two panels — what needs a decision now, and
 * what is coming in the next fortnight.
 *
 * References: 7shifts' "vs last Monday" stat row, Fresha's stat cards with a
 * sparkline under the figure, Zillow Rental Manager's "Upcoming tours" and
 * "Next steps" panels side by side.
 */

import Link from "next/link";
import { ArrowDownRight, ArrowUpRight, ChevronDown, Minus } from "lucide-react";
import { cn } from "@/lib/utils";
import { DASHBOARD_PERIOD_LABELS, type DashboardPeriodKind, type KpiDelta } from "@/lib/dashboard-kpis";

/* ───────────────────────── period selector ───────────────────────── */

const PERIOD_ORDER: DashboardPeriodKind[] = ["month", "week", "30d"];

export function DashboardPeriodSelect({
  value,
  onChange,
}: {
  value: DashboardPeriodKind;
  onChange: (next: DashboardPeriodKind) => void;
}) {
  return (
    <label className="relative inline-flex min-h-9 items-center rounded-full border border-border bg-card pl-3 pr-8 text-[12.5px] font-semibold text-foreground">
      <span className="sr-only">Period</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as DashboardPeriodKind)}
        data-attr="dashboard-period"
        className="absolute inset-0 cursor-pointer opacity-0"
        aria-label="Period"
      >
        {PERIOD_ORDER.map((k) => (
          <option key={k} value={k}>
            {DASHBOARD_PERIOD_LABELS[k].current}
          </option>
        ))}
      </select>
      <span aria-hidden>{DASHBOARD_PERIOD_LABELS[value].current}</span>
      <ChevronDown className="pointer-events-none absolute right-2.5 size-3.5 text-muted" aria-hidden />
    </label>
  );
}

/* ───────────────────────── sparkline ───────────────────────── */

/**
 * Eight thin bars, the last one the current period. One series, one hue; the
 * current bar is solid and the history is tinted so the eye lands on now.
 * Each bar carries its value as a title, which is the whole hover layer a
 * sparkline this small needs.
 */
export function Sparkline({
  values,
  labels,
  format,
}: {
  values: readonly number[];
  labels: readonly string[];
  format: (n: number) => string;
}) {
  const max = Math.max(1, ...values);
  return (
    <div className="flex h-7 items-end gap-[3px]" role="img" aria-label={`Last ${values.length} periods`}>
      {values.map((v, i) => {
        const last = i === values.length - 1;
        const h = Math.max(2, Math.round((v / max) * 28));
        return (
          <span
            key={i}
            title={`${labels[i] ?? ""}: ${format(v)}`}
            className={cn("block w-[7px] rounded-t-[3px]", last ? "bg-primary" : "bg-primary/25")}
            style={{ height: `${h}px` }}
          />
        );
      })}
    </div>
  );
}

/* ───────────────────────── KPI card ───────────────────────── */

export function KpiCard({
  label,
  value,
  unit,
  detail,
  delta,
  series,
  seriesLabels,
  format,
  href,
  dataAttr,
}: {
  label: string;
  value: string;
  /** A small unit after the figure — "%", "/ 42". */
  unit?: string;
  detail: string;
  delta: KpiDelta | null;
  /** Eight values, oldest first. Omit when the source has no history. */
  series?: readonly number[];
  seriesLabels?: readonly string[];
  format?: (n: number) => string;
  href: string;
  dataAttr?: string;
}) {
  const Arrow = delta?.direction === "up" ? ArrowUpRight : delta?.direction === "down" ? ArrowDownRight : Minus;
  return (
    <Link
      href={href}
      data-attr={dataAttr}
      className="flex min-w-0 flex-col gap-2 rounded-2xl border border-border bg-card px-4 py-3.5 shadow-sm transition hover:border-primary/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
    >
      <span className="text-[12.5px] font-medium text-muted">{label}</span>
      <span className="flex items-end justify-between gap-3">
        <span className="min-w-0 truncate text-[1.65rem] font-semibold leading-none tracking-[-0.02em] text-foreground">
          {value}
        </span>
        {series && series.length > 0 ? (
          <Sparkline values={series} labels={seriesLabels ?? []} format={format ?? String} />
        ) : null}
      </span>
      <span className="min-h-[15px] truncate text-[12px] font-medium text-muted">{unit ?? ""}</span>
      <span className="-mt-1 flex min-w-0 items-center gap-1.5 text-[11.5px] leading-snug">
        {delta ? (
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-0.5 font-semibold",
              delta.direction === "up"
                ? "text-[var(--status-confirmed-fg)]"
                : delta.direction === "down"
                  ? "text-[var(--status-overdue-fg)]"
                  : "text-muted",
            )}
          >
            <Arrow className="size-3" aria-hidden />
            {delta.label}
          </span>
        ) : (
          <span className="truncate text-muted">{detail}</span>
        )}
      </span>
    </Link>
  );
}

/* ───────────────────────── panels ───────────────────────── */

export type AttentionRow = {
  id: string;
  title: string;
  detail: string;
  actionLabel: "Review" | "Approve" | "Remind" | "Set up" | "Sign" | "Confirm" | "Continue" | "Reply";
  href: string;
  tone: "danger" | "pending" | "info";
};

const ROW_DOT: Record<AttentionRow["tone"], string> = {
  danger: "bg-[var(--status-overdue-fg)]",
  pending: "bg-[var(--status-pending-fg)]",
  info: "bg-primary",
};

function PanelShell({
  title,
  count,
  aside,
  children,
  dataAttr,
}: {
  title: string;
  count?: number;
  aside?: React.ReactNode;
  children: React.ReactNode;
  dataAttr: string;
}) {
  return (
    <section className="flex min-w-0 flex-col rounded-2xl border border-border bg-card shadow-sm" data-attr={dataAttr}>
      <div className="flex items-center gap-2 border-b border-border/70 px-4 py-3">
        <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">{title}</h2>
        {count != null && count > 0 ? (
          <span className="rounded-full bg-[var(--secondary)] px-2 py-px text-[11px] font-semibold tabular-nums text-muted">
            {count}
          </span>
        ) : null}
        <span className="ml-auto">{aside}</span>
      </div>
      {children}
    </section>
  );
}

/**
 * Needs attention — four to six rows, each with the one action that clears
 * it. Replaces the single "next step" banner, which could only ever say one
 * thing while five things waited.
 */
export function AttentionPanel({ rows }: { rows: AttentionRow[] }) {
  return (
    <PanelShell title="Needs attention" count={rows.length} dataAttr="dashboard-attention-panel">
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-[13px] text-muted">Nothing is waiting on you. Nice.</p>
      ) : (
        <ul className="divide-y divide-border/70">
          {rows.map((row) => (
            <li key={row.id} className="flex items-center gap-3 px-4 py-2.5" data-attr={`dashboard-attention-${row.id}`}>
              <span className={cn("size-2 shrink-0 rounded-full", ROW_DOT[row.tone])} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-medium text-foreground">{row.title}</span>
                <span className="block truncate text-[12px] text-muted">{row.detail}</span>
              </span>
              <Link
                href={row.href}
                className="inline-flex min-h-9 shrink-0 items-center rounded-full border border-border bg-card px-3 text-[12.5px] font-semibold text-foreground transition hover:border-primary/40 hover:text-primary"
              >
                {row.actionLabel}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </PanelShell>
  );
}

export type UpcomingRow = {
  id: string;
  /** "Tour", "Move-in inspection", "Lease ends". */
  kind: string;
  title: string;
  detail: string;
  /** Epoch ms; rows are sorted by it. */
  at: number;
  href: string;
};

function dayLabel(ms: number, nowMs: number): { day: string; time: string } {
  const d = new Date(ms);
  const today = new Date(nowMs);
  const sameDay = d.toDateString() === today.toDateString();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const isTomorrow = d.toDateString() === tomorrow.toDateString();
  const day = sameDay
    ? "Today"
    : isTomorrow
      ? "Tomorrow"
      : d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  const hasTime = d.getHours() !== 0 || d.getMinutes() !== 0;
  const time = hasTime ? d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "";
  return { day, time };
}

/** Upcoming — tours, inspections and lease ends in the next 14 days, from the Calendar's rows. */
export function UpcomingPanel({ rows, nowMs, calendarHref }: { rows: UpcomingRow[]; nowMs: number; calendarHref: string }) {
  const sorted = [...rows].sort((a, b) => a.at - b.at).slice(0, 6);
  return (
    <PanelShell
      title="Upcoming"
      aside={
        <Link href={calendarHref} className="text-[12.5px] font-semibold text-primary hover:underline">
          Calendar →
        </Link>
      }
      dataAttr="dashboard-upcoming-panel"
    >
      {sorted.length === 0 ? (
        <p className="px-4 py-6 text-center text-[13px] text-muted">Nothing scheduled in the next two weeks.</p>
      ) : (
        <ul className="divide-y divide-border/70">
          {sorted.map((row) => {
            const { day, time } = dayLabel(row.at, nowMs);
            return (
              <li key={row.id}>
                <Link
                  href={row.href}
                  className="flex items-center gap-3 px-4 py-2.5 transition hover:bg-accent/30"
                  data-attr={`dashboard-upcoming-${row.id}`}
                >
                  <span className="w-[76px] shrink-0 leading-tight">
                    <span className="block text-[12.5px] font-semibold text-foreground">{day}</span>
                    <span className="block text-[11.5px] text-muted">{time || "All day"}</span>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium text-foreground">
                      <span className="text-muted">{row.kind} · </span>
                      {row.title}
                    </span>
                    <span className="block truncate text-[12px] text-muted">{row.detail}</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </PanelShell>
  );
}
