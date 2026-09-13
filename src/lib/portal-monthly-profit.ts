export type MonthPoint = { key: string; label: string; value: number };

export type MonthlyProfitPoint = { key: string; label: string; profit: number };

export type MonthlyCashflowPoint = {
  key: string;
  label: string;
  revenue: number;
  expense: number;
  profit: number;
};

export type CashflowChartMetric = "revenue" | "profit" | "expense";

export const CASHFLOW_CHART_RANGE_MONTHS = [3, 6, 12, 24] as const;
export type CashflowChartRangeMonths = (typeof CASHFLOW_CHART_RANGE_MONTHS)[number];

/** X-axis month labels: 2Y view shows every third month (plus the latest). */
export function cashflowChartShowMonthLabel(
  index: number,
  total: number,
  rangeMonths: CashflowChartRangeMonths,
): boolean {
  if (rangeMonths !== 24 || total <= 12) return true;
  return index % 3 === 0 || index === total - 1;
}

/** The last N calendar months (oldest → current), keyed `YYYY-MM` with a short label. */
export function lastNMonths(nowMs: number, count = 6): { key: string; label: string }[] {
  const base = new Date(nowMs);
  const out: { key: string; label: string }[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const m = new Date(base.getFullYear(), base.getMonth() - i, 1);
    out.push({
      key: `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, "0")}`,
      label: m.toLocaleString("en-US", { month: "short" }),
    });
  }
  return out;
}

/** `YYYY-MM` bucket key for an ISO date, or null when unparseable. */
export function monthKeyOf(iso: string | undefined | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Sum a list into month buckets by an ISO-date accessor. */
export function bucketByMonth<T>(
  items: T[],
  months: { key: string; label: string }[],
  dateOf: (item: T) => string | undefined | null,
  amountOf: (item: T) => number,
): MonthPoint[] {
  const sums = new Map(months.map((m) => [m.key, 0]));
  for (const item of items) {
    const key = monthKeyOf(dateOf(item));
    if (key && sums.has(key)) sums.set(key, sums.get(key)! + (amountOf(item) || 0));
  }
  return months.map((m) => ({ key: m.key, label: m.label, value: sums.get(m.key) ?? 0 }));
}

export function mergeMonthlyProfit(payments: MonthPoint[], expenses: MonthPoint[]): MonthlyProfitPoint[] {
  return mergeMonthlyCashflow(payments, expenses).map((p) => ({
    key: p.key,
    label: p.label,
    profit: p.profit,
  }));
}

export function mergeMonthlyCashflow(payments: MonthPoint[], expenses: MonthPoint[]): MonthlyCashflowPoint[] {
  return payments.map((p, i) => {
    const expense = expenses[i]?.value ?? 0;
    return {
      key: p.key,
      label: p.label,
      revenue: p.value,
      expense,
      profit: p.value - expense,
    };
  });
}

export function cashflowMetricValue(point: MonthlyCashflowPoint, metric: CashflowChartMetric): number {
  return point[metric];
}

/** Last vs first in the visible window — colors the line, not the scrubbed point. */
export function cashflowWindowDirection(values: number[]): "up" | "down" | "flat" {
  if (values.length === 0) return "flat";
  const first = values[0] ?? 0;
  const last = values[values.length - 1] ?? 0;
  if (last > first) return "up";
  if (last < first) return "down";
  return "flat";
}

/** Parse a "$1,200.00" balance label into a numeric dollar amount. */
export function parseMoneyLabel(label: string): number {
  const n = Number(String(label).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}
