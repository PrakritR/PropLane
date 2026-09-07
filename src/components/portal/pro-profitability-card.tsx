"use client";

import { useEffect, useMemo, useState } from "react";
import { CashflowRangeToggle } from "@/components/portal/monthly-profit-chart";
import {
  PORTAL_DATA_TABLE,
  PORTAL_DATA_TABLE_SCROLL,
  PORTAL_DATA_TABLE_WRAP,
  PORTAL_MOBILE_CARD_CLASS,
  PORTAL_TABLE_HEAD_ROW,
  PORTAL_TABLE_TD,
  PORTAL_TABLE_TR,
} from "@/components/portal/portal-data-table";
import { MANAGER_TABLE_TH } from "@/components/portal/portal-metrics";
import { ReportExportButtons } from "@/components/portal/reports/report-filter-bar";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { pacificCalendarDateYmd } from "@/lib/pacific-time";
import type { CashflowChartRangeMonths } from "@/lib/portal-monthly-profit";
import { PROFITABILITY_REPORT_ID, type ProfitabilityGroupBy } from "@/lib/reports/profitability";
import type { ReportColumn, ReportResult, ReportRow } from "@/lib/reports/types";
import { cn } from "@/lib/utils";

/** First day of the month `months − 1` months before `today` (YYYY-MM-DD), so the range covers `months` whole-or-partial months. */
export function profitabilityRangeFrom(todayYmd: string, months: number): string {
  const year = Number(todayYmd.slice(0, 4));
  const month = Number(todayYmd.slice(5, 7));
  const index = year * 12 + (month - 1) - (months - 1);
  const fromYear = Math.floor(index / 12);
  const fromMonth = (index % 12) + 1;
  return `${fromYear}-${String(fromMonth).padStart(2, "0")}-01`;
}

const GROUP_OPTIONS: { id: ProfitabilityGroupBy; label: string }[] = [
  { id: "property", label: "By property" },
  { id: "month", label: "By month" },
];

const SOURCE_META_KEYS: { key: string; label: string }[] = [
  { key: "source_grossRent", label: "Gross rent" },
  { key: "source_otherIncome", label: "Other income" },
  { key: "source_processingFees", label: "Processing fees" },
  { key: "source_vendorPayouts", label: "Vendor payouts" },
  { key: "source_commsCost", label: "Communication" },
  { key: "source_expenses", label: "Expenses" },
];

function cellAlign(col: ReportColumn): string {
  return col.align === "right" ? "text-right tabular-nums" : "text-left";
}

function cellText(value: unknown): string {
  const text = String(value ?? "").trim();
  return text || "—";
}

function netClass(value: unknown): string {
  return String(value ?? "").startsWith("-") ? "text-[var(--status-overdue-fg)]" : "text-foreground";
}

/**
 * Read-only profitability summary for Finances → Income (PRP-278). Every cell
 * is a figure the server summed from ledger / payout / usage rows; the card
 * never computes money itself. The month range reuses the cash-flow chart's
 * range pills, and CSV export goes through the shared report export route.
 */
export function ManagerProfitabilityCard({ propertyId, className }: { propertyId?: string; className?: string }) {
  const [rangeMonths, setRangeMonths] = useState<CashflowChartRangeMonths>(6);
  const [groupBy, setGroupBy] = useState<ProfitabilityGroupBy>("property");
  const [report, setReport] = useState<ReportResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSources, setShowSources] = useState(false);
  // Demo is decided once on mount: the sandbox has no authenticated reports API.
  const [demo, setDemo] = useState<boolean | null>(null);
  useEffect(() => {
    setDemo(isDemoModeActive());
  }, []);

  // The clock is read inside the effect, never during render, so two renders in
  // one tick cannot disagree about the window (same rule as the cash-flow chart).
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (demo !== false) return;
    const to = pacificCalendarDateYmd();
    const params = new URLSearchParams({ from: profitabilityRangeFrom(to, rangeMonths), to, groupBy });
    if (propertyId) params.set("propertyId", propertyId);
    setQuery(params.toString());
  }, [demo, rangeMonths, groupBy, propertyId]);

  useEffect(() => {
    if (!query) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void fetch(`/api/reports/${PROFITABILITY_REPORT_ID}?${query}`)
      .then(async (res) => {
        const data = (await res.json()) as ReportResult & { error?: string };
        if (!res.ok) throw new Error(data.error ?? "Failed to load profitability.");
        if (!cancelled) setReport(data);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setReport(null);
        setError(e instanceof Error ? e.message : "Failed to load profitability.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [query]);

  const columns = useMemo(() => report?.columns ?? [], [report]);
  const sources = useMemo(
    () =>
      SOURCE_META_KEYS.map(({ key, label }) => ({ label, text: String(report?.meta?.[key] ?? "") })).filter(
        (s) => s.text,
      ),
    [report],
  );

  if (demo !== false) return null;

  const rows: ReportRow[] = report?.rows ?? [];
  const hasRows = rows.length > 0;

  return (
    <section
      className={cn(
        "rounded-xl border border-border bg-card p-4 sm:p-5 lg:p-6 [html[data-native]_&]:p-3.5 max-lg:p-3",
        className,
      )}
      data-attr="profitability-card"
      aria-busy={loading}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2 sm:gap-3">
          <h2 className="text-base font-semibold tracking-[-0.01em] text-foreground lg:text-lg">Profitability</h2>
          <div
            className="flex rounded-full border border-border bg-accent/25 p-0.5"
            role="tablist"
            aria-label="Profitability grouping"
          >
            {GROUP_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                role="tab"
                aria-selected={groupBy === opt.id}
                data-attr={`profitability-group-${opt.id}`}
                className={cn(
                  "portal-pressable min-h-11 min-w-0 rounded-full px-3 py-2 text-center text-[11px] font-semibold transition-colors sm:text-xs",
                  groupBy === opt.id ? "bg-card text-foreground shadow-[var(--shadow-sm)]" : "text-muted hover:text-foreground",
                )}
                onClick={() => setGroupBy(opt.id)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <CashflowRangeToggle
            value={rangeMonths}
            onChange={setRangeMonths}
            ariaLabel="Profitability time range"
            dataAttrPrefix="profitability-range"
          />
          {hasRows && query ? <ReportExportButtons reportId={PROFITABILITY_REPORT_ID} query={query} formats={["csv"]} /> : null}
        </div>
      </div>
      <p className="mt-1 text-sm text-muted">
        Net = gross rent + other income − processing fees − vendor payouts − communication − expenses.
      </p>

      {error ? (
        <p className="mt-3 text-sm text-[var(--status-overdue-fg)]" role="alert">
          {error}
        </p>
      ) : !report && loading ? (
        <p className="mt-3 text-sm text-muted">Loading profitability…</p>
      ) : !hasRows ? (
        <p className="mt-3 text-sm text-muted" data-attr="profitability-empty">
          No collected rent, expenses, payouts or billed communication in this range yet.
        </p>
      ) : (
        <>
          <div className="mt-3 space-y-2 lg:hidden">
            {rows.map((row, idx) => (
              <div key={`${row.propertyId ?? ""}-${row.monthKey ?? ""}-${idx}`} className={PORTAL_MOBILE_CARD_CLASS}>
                <div className="mb-1 flex items-start justify-between gap-2">
                  <p className="min-w-0 text-sm font-medium text-foreground">
                    {cellText(row.property)}
                    {row.month ? <span className="text-muted"> · {cellText(row.month)}</span> : null}
                  </p>
                  <p className={cn("text-sm font-semibold tabular-nums", netClass(row.net))}>{cellText(row.net)}</p>
                </div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                  {columns
                    .filter((col) => col.key !== "property" && col.key !== "month" && col.key !== "net")
                    .map((col) => (
                      <div key={col.key} className="min-w-0">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted/70">{col.label}</p>
                        <p className="break-words text-sm tabular-nums text-foreground/80">{cellText(row[col.key])}</p>
                      </div>
                    ))}
                </div>
              </div>
            ))}
            {report?.totals ? (
              <div className={`${PORTAL_MOBILE_CARD_CLASS} bg-accent/10`} data-attr="profitability-totals-mobile">
                <div className="mb-1 flex items-start justify-between gap-2">
                  <p className="text-sm font-semibold text-foreground">Total</p>
                  <p className={cn("text-sm font-semibold tabular-nums", netClass(report.totals.net))}>
                    {cellText(report.totals.net)}
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                  {columns
                    .filter((col) => col.key !== "property" && col.key !== "month" && col.key !== "net")
                    .map((col) => (
                      <div key={col.key} className="min-w-0">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted/70">{col.label}</p>
                        <p className="break-words text-sm font-semibold tabular-nums text-foreground">
                          {cellText(report.totals![col.key])}
                        </p>
                      </div>
                    ))}
                </div>
              </div>
            ) : null}
          </div>

          <div className={`${PORTAL_DATA_TABLE_WRAP} mt-3 hidden lg:block`}>
            <div className={PORTAL_DATA_TABLE_SCROLL}>
              <table className={PORTAL_DATA_TABLE} data-attr="profitability-table">
                <thead>
                  <tr className={PORTAL_TABLE_HEAD_ROW}>
                    {columns.map((col) => (
                      <th
                        key={col.key}
                        className={`${MANAGER_TABLE_TH} ${cellAlign(col)} px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.08em]`}
                      >
                        {col.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, idx) => (
                    <tr key={`${row.propertyId ?? ""}-${row.monthKey ?? ""}-${idx}`} className={PORTAL_TABLE_TR}>
                      {columns.map((col) => (
                        <td
                          key={col.key}
                          className={cn(
                            PORTAL_TABLE_TD,
                            cellAlign(col),
                            (col.key === "property" || col.key === "month") && "font-medium text-foreground",
                            col.key === "net" && `font-semibold ${netClass(row.net)}`,
                          )}
                        >
                          {cellText(row[col.key])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
                {report?.totals ? (
                  <tfoot>
                    <tr className="border-t-2 border-border bg-accent/10 text-sm font-semibold" data-attr="profitability-totals">
                      {columns.map((col) => (
                        <td
                          key={col.key}
                          className={cn(PORTAL_TABLE_TD, cellAlign(col), col.key === "net" && netClass(report.totals!.net))}
                        >
                          {cellText(report.totals![col.key])}
                        </td>
                      ))}
                    </tr>
                  </tfoot>
                ) : null}
              </table>
            </div>
          </div>
        </>
      )}

      {sources.length > 0 ? (
        <div className="mt-3">
          <button
            type="button"
            className="text-xs font-medium text-muted underline-offset-2 hover:text-foreground hover:underline"
            aria-expanded={showSources}
            onClick={() => setShowSources((v) => !v)}
            data-attr="profitability-sources-toggle"
          >
            {showSources ? "Hide" : "Where each column comes from"}
          </button>
          {showSources ? (
            <dl className="mt-2 grid gap-1 text-xs text-muted sm:grid-cols-[auto_1fr] sm:gap-x-3">
              {sources.map((s) => (
                <div key={s.label} className="contents">
                  <dt className="font-medium text-foreground/80">{s.label}</dt>
                  <dd className="min-w-0 break-words">{s.text}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
