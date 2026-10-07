"use client";

/**
 * The head of every dashboard (manager, vendor; the resident one borrows the
 * tile and tones): hairline KPI cards that each carry a direction and a few
 * bars of history when the source has them, a period selector that sets their
 * baseline, and two hairline panels — what needs a decision now, and what is
 * coming in the next fortnight. Rows lead with a 28px tinted glyph tile, then
 * a title, a place line and the one action that clears the row.
 */

import Link from "next/link";
import {
  AlertCircle,
  ArrowDownRight,
  ArrowUpRight,
  CalendarDays,
  ChevronRight,
  ClipboardCheck,
  ClipboardList,
  FileSignature,
  Home,
  MapPin,
  MessageSquare,
  Minus,
  Phone,
  Wallet,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { FIELD_SELECT_TRIGGER_TOOLBAR_PILL_CLASS } from "@/components/ui/field-select-styles";
import { cn } from "@/lib/utils";
import type { ManagerAttentionRow } from "@/lib/manager-attention-queue";
import { DASHBOARD_PERIOD_LABELS, type DashboardPeriodKind, type KpiDelta } from "@/lib/dashboard-kpis";
import { formatPacificDate, pacificCalendarDateYmd } from "@/lib/pacific-time";

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
    <FieldSingleSelect
      variant="pill"
      label="Period"
      value={value}
      onChange={(next) => onChange(next as DashboardPeriodKind)}
      options={PERIOD_ORDER.map((k) => ({ value: k, label: DASHBOARD_PERIOD_LABELS[k].current }))}
      dataAttr="dashboard-period"
      triggerClassName={FIELD_SELECT_TRIGGER_TOOLBAR_PILL_CLASS}
    />
  );
}

/* ───────────────────────── glyph tile ───────────────────────── */

export type DashboardTone = "danger" | "pending" | "info" | "success";

const TILE_TONE: Record<DashboardTone, string> = {
  danger: "bg-[var(--status-overdue-bg)] text-[var(--status-overdue-fg)]",
  pending: "bg-[var(--status-pending-bg)] text-[var(--status-pending-fg)]",
  info: "bg-[var(--status-approved-bg)] text-[var(--status-approved-fg)]",
  success: "bg-[var(--status-confirmed-bg)] text-[var(--status-confirmed-fg)]",
};

/** The 28px tinted glyph tile every dashboard row leads with (decorative). */
export function DashboardGlyphTile({
  icon: Icon,
  tone = "info",
  className,
}: {
  icon: LucideIcon;
  tone?: DashboardTone;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      data-slot="dashboard-glyph-tile"
      className={cn("grid size-7 shrink-0 place-items-center rounded-[7px]", TILE_TONE[tone], className)}
    >
      <Icon className="size-3.5" aria-hidden />
    </span>
  );
}

/* ───────────────────────── sparkline ───────────────────────── */

/**
 * Tiny bars pinned to the card's top-right corner, the last one the current
 * period. One series, one hue; the current bar is solid and the history is
 * tinted so the eye lands on now. Each bar carries its value as a title,
 * which is the whole hover layer a sparkline this small needs.
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
    <div
      className="absolute right-3.5 top-4 hidden h-[30px] items-end gap-[2px] sm:flex"
      role="img"
      aria-label={`Last ${values.length} periods`}
      data-slot="kpi-sparkline"
    >
      {values.map((v, i) => {
        const last = i === values.length - 1;
        const h = Math.max(2, Math.round((v / max) * 30));
        return (
          <span
            key={i}
            title={`${labels[i] ?? ""}: ${format(v)}`}
            className={cn("block w-1 rounded-[1px]", last ? "bg-primary" : "bg-primary/25")}
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
  icon: Icon,
}: {
  label: string;
  value: string;
  /** The line under the figure — "5 / 7", "2 properties". */
  unit?: string;
  /** Only drawn when there is neither a `unit` line nor a delta. */
  detail?: string;
  delta?: KpiDelta | null;
  /** Eight values, oldest first. Omit when the source has no history. */
  series?: readonly number[];
  seriesLabels?: readonly string[];
  format?: (n: number) => string;
  href: string;
  dataAttr?: string;
  /** Optional small glyph next to the label — additive, no existing caller sets it. */
  icon?: LucideIcon;
}) {
  const Arrow = delta?.direction === "up" ? ArrowUpRight : delta?.direction === "down" ? ArrowDownRight : Minus;
  const hasSeries = Boolean(series && series.length > 0);
  const subLine = unit || (!delta ? detail : undefined);
  return (
    <Link
      href={href}
      data-attr={dataAttr}
      className="relative flex h-full min-w-0 flex-col rounded-[10px] border border-border bg-card px-4 py-3.5 transition-colors hover:border-foreground/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
    >
      <span className={cn("flex items-center gap-1.5 text-[13px] font-[550] text-muted", hasSeries && "sm:pr-14")}>
        {Icon ? <Icon className="size-3.5 shrink-0" aria-hidden /> : null}
        <span className="truncate">{label}</span>
      </span>
      <span className="my-1 block whitespace-nowrap text-[26px] font-[650] leading-[1.15] tracking-[-0.03em] text-foreground">
        {value}
      </span>
      {subLine ? <span className="truncate text-[12.5px] text-muted">{subLine}</span> : null}
      {delta ? (
        <span
          className={cn(
            "mt-1.5 flex min-w-0 items-center gap-1 text-[12.5px]",
            delta.direction === "up"
              ? "text-[var(--status-confirmed-fg)]"
              : delta.direction === "down"
                ? "text-[var(--status-overdue-fg)]"
                : "text-muted",
          )}
        >
          <Arrow className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{delta.label}</span>
        </span>
      ) : null}
      {hasSeries ? <Sparkline values={series!} labels={seriesLabels ?? []} format={format ?? String} /> : null}
    </Link>
  );
}

/* ───────────────────────── panels ───────────────────────── */

export type AttentionRow = ManagerAttentionRow;

/** Which glyph a queue row wears, by its stable id. */
const ROW_GLYPH: Record<string, LucideIcon> = {
  overdue: AlertCircle,
  applications: ClipboardList,
  leases: FileSignature,
  tours: MapPin,
  messaging: Phone,
  drafts: Home,
  inbox: MessageSquare,
  bids: Wrench,
  payouts: Wallet,
};

export function PanelShell({
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
    <section className="flex h-full min-w-0 flex-col overflow-hidden rounded-[10px] border border-border bg-card" data-attr={dataAttr}>
      <div className="flex items-center gap-2 border-b border-border px-3.5 py-[11px]">
        <h2 className="text-sm font-[650] text-foreground">{title}</h2>
        {count != null && count > 0 ? (
          <span className="text-[12.5px] font-medium tabular-nums text-muted/70">{count}</span>
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
export function AttentionPanel({
  rows,
  hideRowDetail = false,
  emptyCopy = "Nothing is waiting on you. Nice.",
  rowClassName = "flex items-center gap-2.5 px-3.5 py-2.5",
  actionClassName = "inline-flex min-h-11 shrink-0 items-center rounded-[7px] border border-border bg-card px-3 text-[13px] font-[550] text-foreground transition hover:bg-[var(--secondary)] lg:min-h-8",
}: {
  rows: AttentionRow[];
  /** Vendor metrics already carry the relevant status in their title. */
  hideRowDetail?: boolean;
  /** Surface-specific, factual empty state; manager copy remains the default. */
  emptyCopy?: string;
  rowClassName?: string;
  actionClassName?: string;
}) {
  return (
    <PanelShell title="Needs attention" count={rows.length} dataAttr="dashboard-attention-panel">
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-[13px] text-muted">{emptyCopy}</p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((row) => (
            <li key={row.id} className={rowClassName} data-attr={`dashboard-attention-${row.id}`}>
              <DashboardGlyphTile icon={ROW_GLYPH[row.id] ?? ClipboardList} tone={row.tone} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-foreground">{row.title}</span>
                {!hideRowDetail ? <span className="block truncate text-[12.5px] text-muted">{row.detail}</span> : null}
              </span>
              <Link href={row.href} className={actionClassName}>
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

/** Glyph and tint for an upcoming row, by what kind of event it is. */
function upcomingGlyph(kind: string): { icon: LucideIcon; tone: DashboardTone } {
  const k = kind.toLowerCase();
  if (k.startsWith("tour")) return { icon: MapPin, tone: "info" };
  if (k.includes("inspection")) return { icon: ClipboardCheck, tone: "success" };
  if (k.includes("lease")) return { icon: CalendarDays, tone: "pending" };
  return { icon: Wrench, tone: "pending" };
}

/**
 * C240: `Date.prototype.getHours`/`toLocaleTimeString` without a `timeZone`
 * read the SERVER's (or the browser's) local clock, not the workspace's —
 * a tour stored for 10:00 AM Pacific rendered as an implausible early-morning
 * hour whenever that process clock sat in a different zone. Every wall-time
 * read here goes through `pacific-time.ts`, the same zone every other
 * tour/schedule surface in the app is pinned to (`tours-scheduling.md`).
 */
export function dayLabel(ms: number, nowMs: number): { day: string; time: string } {
  const dateYmd = pacificCalendarDateYmd(ms);
  const todayYmd = pacificCalendarDateYmd(nowMs);
  const tomorrowYmd = pacificCalendarDateYmd(nowMs + 24 * 60 * 60 * 1000);
  const day =
    dateYmd === todayYmd
      ? "Today"
      : dateYmd === tomorrowYmd
        ? "Tomorrow"
        : formatPacificDate(ms, { weekday: "short", month: "short", day: "numeric" });
  const [hourPart, minutePart] = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  })
    .formatToParts(new Date(ms))
    .reduce<[string, string]>(
      (acc, part) => (part.type === "hour" ? [part.value, acc[1]] : part.type === "minute" ? [acc[0], part.value] : acc),
      ["0", "0"],
    );
  const hasTime = Number(hourPart) !== 0 || Number(minutePart) !== 0;
  const time = hasTime ? formatPacificDate(ms, { hour: "numeric", minute: "2-digit" }) : "";
  return { day, time };
}

/** Upcoming — tours, inspections and lease ends in the next 14 days, from the Calendar's rows. */
export function UpcomingPanel({
  rows,
  nowMs,
  calendarHref,
  emptyCopy = "Nothing scheduled in the next two weeks.",
  aside,
  rowLinkClassName = "flex items-center gap-2.5 px-3.5 py-2.5 transition hover:bg-[var(--secondary)]",
}: {
  rows: UpcomingRow[];
  nowMs: number;
  calendarHref: string;
  /** Surface-specific, factual empty state; manager copy remains the default. */
  emptyCopy?: string;
  /** Replaces the default text Calendar link while preserving shared row behavior; `null` draws none. */
  aside?: React.ReactNode;
  rowLinkClassName?: string;
}) {
  const sorted = [...rows].sort((a, b) => a.at - b.at).slice(0, 6);
  return (
    <PanelShell
      title="Upcoming"
      aside={aside !== undefined ? aside : (
        <Link href={calendarHref} className="inline-flex items-center gap-0.5 text-[13px] font-[550] text-primary hover:underline">
          Calendar
          <ChevronRight className="size-3.5" aria-hidden />
        </Link>
      )}
      dataAttr="dashboard-upcoming-panel"
    >
      {sorted.length === 0 ? (
        <p className="px-4 py-6 text-center text-[13px] text-muted">{emptyCopy}</p>
      ) : (
        <ul className="divide-y divide-border">
          {sorted.map((row) => {
            const { day, time } = dayLabel(row.at, nowMs);
            const glyph = upcomingGlyph(row.kind);
            return (
              <li key={row.id}>
                {/* The analytics name is the fixed kebab name every funnel joins
                    on, never `row.id`: those ids carry a stored record key
                    (`tour-<uuid>`, `visit-<uuid>`), which both explodes
                    autocapture cardinality and walks locally stored row text
                    into a rendered DOM attribute (CodeQL `js/xss-through-dom`).
                    The row's href already says which record was opened. */}
                <Link href={row.href} className={rowLinkClassName} data-attr="dashboard-upcoming-row">
                  <DashboardGlyphTile icon={glyph.icon} tone={glyph.tone} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-foreground">
                      {row.kind} · {row.title}
                    </span>
                    <span className="block truncate text-[12.5px] text-muted">
                      {[`${day}${time ? ` ${time}` : ""}`, row.detail].filter(Boolean).join(" · ")}
                    </span>
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
