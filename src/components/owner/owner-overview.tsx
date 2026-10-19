"use client";

import { CalendarDays, ClipboardCheck, FileSignature, FileText, Wrench } from "lucide-react";
import Link from "next/link";
import { formatOwnerUsd, ownerMonthLabel, useOwnerFetch } from "@/components/owner/owner-data";
import { OwnerEmpty, OwnerError, OwnerLoading } from "@/components/owner/owner-ui";
import { useOwnerWorkspace } from "@/components/owner/owner-workspace";
import { DashboardGlyphTile, KpiCard, PanelShell } from "@/components/portal/pro-dashboard-kpis";
import { formatPacificDate } from "@/lib/pacific-time";
import { OWNER_BASE_PATH } from "@/lib/property-owner/sections";
import type {
  OwnerAttentionItem,
  OwnerChartPoint,
  OwnerOverviewExtras,
  OwnerSummary,
  OwnerUpcomingItem,
} from "@/lib/property-owner/projection";

export function OwnerIncomeChart({ points, periodLabel = "last 12 months" }: { points: OwnerChartPoint[]; periodLabel?: string }) {
  const max = Math.max(1, ...points.flatMap((p) => [p.incomeCents, p.expensesCents]));
  return (
    <div className="rounded-[10px] border border-border bg-card p-4" data-attr="owner-chart">
      <p className="text-sm font-[650] text-foreground">Income and expenses · {periodLabel}</p>
      <div className="mt-3 flex h-24 items-end gap-1.5" role="img" aria-label={`Income and expenses for the ${periodLabel}`}>
        {points.map((p) => (
          <div
            key={p.month}
            className="flex h-full flex-1 items-end justify-center gap-0.5"
            title={`${ownerMonthLabel(p.month)}: income ${formatOwnerUsd(p.incomeCents)} · expenses ${formatOwnerUsd(p.expensesCents)}`}
          >
            <i className="block w-1/2 rounded-t bg-primary" style={{ height: `${(p.incomeCents / max) * 100}%` }} />
            <i className="block w-1/2 rounded-t bg-muted/40" style={{ height: `${(p.expensesCents / max) * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-1.5 text-[10px] text-muted">
        {points.map((p) => (
          <span key={p.month} className="flex-1 text-center">
            {ownerMonthLabel(p.month, true)}
          </span>
        ))}
      </div>
      <div className="mt-2 flex gap-4 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5">
          <i className="inline-block size-2 rounded-sm bg-primary" /> Income
        </span>
        <span className="inline-flex items-center gap-1.5">
          <i className="inline-block size-2 rounded-sm bg-muted/40" /> Expenses
        </span>
      </div>
    </div>
  );
}

/** The five cards. A managed workspace shows PropLane's fee, the owner's net and what can be withdrawn; any other shows net income. */
export function OwnerKpis({
  summary,
  extras,
  yearToDateKnown = true,
  rentDueKnown = true,
}: {
  summary: OwnerSummary;
  extras: OwnerOverviewExtras | null;
  /** False where the year's figure is not supplied (the homepage sample): the card reads a dash, never a made-up zero. */
  yearToDateKnown?: boolean;
  /** False where rent due is not supplied (the homepage sample). */
  rentDueKnown?: boolean;
}) {
  const t = summary.totals;
  const occupancy = t.units > 0 ? Math.round((t.occupied / t.units) * 100) : 0;
  const month = ownerMonthLabel(summary.period, true);
  const cards = [
    <KpiCard
      key="occupancy"
      label="Occupancy"
      value={`${occupancy}%`}
      unit={`${t.occupied} of ${t.units} rooms`}
      href={`${OWNER_BASE_PATH}/properties`}
      dataAttr="owner-kpi-occupancy"
    />,
    <KpiCard
      key="rent"
      label={`Rent collected · ${month}`}
      // PropLane-held rent never touches the manager's own books, so a managed workspace reads it from its ledger.
      value={formatOwnerUsd(extras?.managed ? extras.managed.rentCents : t.rentCollectedCents)}
      unit={extras?.managed || !rentDueKnown ? undefined : `of ${formatOwnerUsd(t.rentDueCents)} due`}
      href={`${OWNER_BASE_PATH}/statements`}
      dataAttr="owner-kpi-rent"
    />,
  ];
  if (extras?.managed) {
    cards.push(
      <KpiCard
        key="fee"
        label="PropLane fee"
        value={formatOwnerUsd(Math.abs(extras.managed.feeCents))}
        unit={month}
        href={`${OWNER_BASE_PATH}/finances`}
        dataAttr="owner-kpi-fee"
      />,
      <KpiCard
        key="net"
        label="Net to you"
        value={formatOwnerUsd(extras.managed.netCents)}
        unit={month}
        href={`${OWNER_BASE_PATH}/statements`}
        dataAttr="owner-kpi-net"
      />,
      <KpiCard
        key="available"
        label="Available to withdraw"
        value={formatOwnerUsd(extras.managed.availableCents)}
        href={`${OWNER_BASE_PATH}/finances`}
        dataAttr="owner-kpi-available"
      />,
    );
  } else {
    cards.push(
      <KpiCard
        key="net-month"
        label={`Net income · ${month}`}
        value={formatOwnerUsd(t.netMonthCents)}
        href={`${OWNER_BASE_PATH}/statements`}
        dataAttr="owner-kpi-net"
      />,
      <KpiCard
        key="net-ytd"
        label={`Net income · ${summary.period.slice(0, 4)}`}
        value={yearToDateKnown ? formatOwnerUsd(t.netYtdCents) : "—"}
        href={`${OWNER_BASE_PATH}/statements`}
        dataAttr="owner-kpi-net-ytd"
      />,
      <KpiCard
        key="due"
        label="Rent due"
        value={rentDueKnown ? formatOwnerUsd(t.rentDueCents) : "—"}
        unit={month}
        href={`${OWNER_BASE_PATH}/statements`}
        dataAttr="owner-kpi-due"
      />,
    );
  }
  return <div className="grid grid-cols-2 gap-3 lg:grid-cols-5 [&>*]:min-w-0" data-attr="owner-kpis">{cards}</div>;
}

type AttentionRow = {
  id: string;
  title: string;
  href: string;
  action: string;
  icon: typeof Wrench;
  tone: "pending" | "info";
};

/** What needs the owner, as rows the Needs attention panel draws: a repair to approve, a statement that landed, an agreement to sign. */
export function ownerAttentionRows(items: readonly OwnerAttentionItem[]): AttentionRow[] {
  return items.map((item) => {
    if (item.kind === "repair") {
      return {
        id: `repair-${item.id}`,
        title: `${item.title} · ${formatOwnerUsd(item.amountCents)}`,
        href: `${OWNER_BASE_PATH}/finances?workspace=${encodeURIComponent(item.workspaceId)}&approve=${encodeURIComponent(item.id)}`,
        action: "Approve",
        icon: Wrench,
        tone: "pending" as const,
      };
    }
    if (item.kind === "statement") {
      return {
        id: `statement-${item.id}`,
        title: `${ownerMonthLabel(item.month)} statement is ready`,
        href: `${OWNER_BASE_PATH}/statements/${encodeURIComponent(item.month)}`,
        action: "View",
        icon: FileText,
        tone: "info" as const,
      };
    }
    return {
      id: `agreement-${item.id}`,
      title: "Management agreement to sign",
      href: `${OWNER_BASE_PATH}/finances?workspace=${encodeURIComponent(item.workspaceId)}&review=${encodeURIComponent(item.id)}`,
      action: "Sign",
      icon: FileSignature,
      tone: "pending" as const,
    };
  });
}

export function OwnerAttentionPanel({ items }: { items: readonly OwnerAttentionItem[] }) {
  const rows = ownerAttentionRows(items);
  return (
    <PanelShell title="Needs attention" count={rows.length} dataAttr="owner-attention-panel">
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-[13px] text-muted">Nothing is waiting on you. Nice.</p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((row) => (
            <li key={row.id} className="flex items-center gap-2.5 px-3.5 py-2.5" data-attr="owner-attention-row">
              <DashboardGlyphTile icon={row.icon} tone={row.tone} />
              <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{row.title}</span>
              <Link
                href={row.href}
                className="inline-flex min-h-11 shrink-0 items-center rounded-[7px] border border-border bg-card px-3 text-[13px] font-[550] text-foreground transition hover:bg-[var(--secondary)] lg:min-h-8"
              >
                {row.action}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </PanelShell>
  );
}

/** "Oct 24" for a plain YYYY-MM-DD, with no time-zone shift. */
export function ownerShortDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return day;
  return formatPacificDate(Date.UTC(y, m - 1, d, 19), { month: "short", day: "numeric" });
}

export function OwnerUpcomingPanel({ items }: { items: readonly OwnerUpcomingItem[] }) {
  return (
    <PanelShell title="Upcoming" dataAttr="owner-upcoming-panel">
      {items.length === 0 ? (
        <p className="px-4 py-6 text-center text-[13px] text-muted">Nothing scheduled in the next month.</p>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((item) => (
            <li key={item.id}>
              <Link
                href={`${OWNER_BASE_PATH}/properties`}
                className="flex items-center gap-2.5 px-3.5 py-2.5 transition hover:bg-[var(--secondary)]"
                data-attr="owner-upcoming-row"
              >
                <DashboardGlyphTile icon={item.kind === "move-in" ? CalendarDays : ClipboardCheck} tone={item.kind === "move-in" ? "info" : "pending"} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-foreground">
                    {item.kind === "move-in" ? "Move-in" : "Move-out"} · {[item.house, item.unit].filter(Boolean).join(" · ")}
                  </span>
                  <span className="block truncate text-[12.5px] text-muted">{ownerShortDay(item.date)}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </PanelShell>
  );
}

/**
 * The overview's successful-data presentation. The live page and the homepage's read-only owner sample both draw it, so the
 * sample is the real screen over supplied data.
 */
export function OwnerOverviewView({
  data,
  extras,
  chartPeriodLabel,
  yearToDateKnown = true,
  rentDueKnown = true,
}: {
  data: OwnerSummary;
  extras: OwnerOverviewExtras | null;
  chartPeriodLabel?: string;
  yearToDateKnown?: boolean;
  rentDueKnown?: boolean;
}) {
  return (
    <>
      <OwnerKpis summary={data} extras={extras} yearToDateKnown={yearToDateKnown} rentDueKnown={rentDueKnown} />
      <div className="grid gap-4 lg:grid-cols-2">
        <OwnerAttentionPanel items={extras?.attention ?? []} />
        <OwnerUpcomingPanel items={extras?.upcoming ?? []} />
      </div>
      <OwnerIncomeChart points={data.chart} periodLabel={chartPeriodLabel} />
    </>
  );
}

/** Overview: the five cards, Needs attention and Upcoming side by side, then the twelve-month chart. */
export function OwnerOverview() {
  const workspace = useOwnerWorkspace();
  const { data, loading, error, reload } = useOwnerFetch<OwnerSummary>("/api/owner/summary");
  const extras = useOwnerFetch<OwnerOverviewExtras>("/api/owner/overview");
  // The empty state is for "no houses are shared with you". A house with rent
  // charged but nothing collected yet is real data: the cards and the chart
  // stay, and the chart simply draws zero bars.
  const empty = !loading && !error && data !== null && data.properties.length === 0;
  return (
    <div className="space-y-4" data-attr="owner-overview" data-workspace={workspace?.activeId ?? undefined}>
      {loading && !data ? (
        <OwnerLoading />
      ) : error === "Forbidden." ? (
        <OwnerEmpty title="No properties are shared with you" />
      ) : error ? (
        <OwnerError message="Couldn't load your properties." onRetry={reload} />
      ) : empty || !data ? (
        <OwnerEmpty />
      ) : (
        <OwnerOverviewView data={data} extras={extras.data} />
      )}
    </div>
  );
}
