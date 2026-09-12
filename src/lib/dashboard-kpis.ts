/**
 * The four numbers at the top of the manager dashboard, and their history.
 *
 * Every figure here is derived from the same local mirrors the list pages
 * read — leases, charges, service requests — bucketed into equal periods so a
 * card can say "vs last month" and draw eight bars of the same thing. Nothing
 * is estimated: a period with no data is a zero, and a metric whose source
 * carries no timestamp (applications) reports no history rather than a
 * pretend one.
 *
 * Pure functions, so the maths is unit-tested without a store.
 */

export type DashboardPeriodKind = "month" | "week" | "30d";

export type DashboardPeriod = {
  /** Inclusive start, epoch ms. */
  start: number;
  /** Exclusive end, epoch ms. */
  end: number;
  /** "Sep", "Sep 1–7", "Aug 13 – Sep 11". */
  label: string;
};

export const DASHBOARD_PERIOD_LABELS: Record<DashboardPeriodKind, { current: string; previous: string }> = {
  month: { current: "This month", previous: "last month" },
  week: { current: "This week", previous: "last week" },
  "30d": { current: "Last 30 days", previous: "the 30 before" },
};

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function shortDate(ms: number): string {
  const d = new Date(ms);
  return `${MONTH_SHORT[d.getMonth()]} ${d.getDate()}`;
}

/**
 * The last `count` periods of a kind, oldest first, the current one last.
 *
 * A month is a calendar month in local time; a week runs Monday to Sunday; a
 * 30-day window ends at the end of today. The current period always contains
 * `nowMs`, so "this month" is the partial month so far.
 */
export function dashboardPeriods(kind: DashboardPeriodKind, nowMs: number, count = 8): DashboardPeriod[] {
  const now = new Date(nowMs);
  const periods: DashboardPeriod[] = [];
  if (kind === "month") {
    for (let i = count - 1; i >= 0; i--) {
      const start = new Date(now.getFullYear(), now.getMonth() - i, 1).getTime();
      const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1).getTime();
      periods.push({ start, end, label: MONTH_SHORT[new Date(start).getMonth()]! });
    }
    return periods;
  }
  if (kind === "week") {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dow = (today.getDay() + 6) % 7; // Monday = 0
    const thisMonday = today.getTime() - dow * DAY_MS;
    for (let i = count - 1; i >= 0; i--) {
      const start = thisMonday - i * 7 * DAY_MS;
      const end = start + 7 * DAY_MS;
      periods.push({ start, end, label: `${shortDate(start)}–${shortDate(end - DAY_MS)}` });
    }
    return periods;
  }
  const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  for (let i = count - 1; i >= 0; i--) {
    const end = endOfToday - i * 30 * DAY_MS;
    const start = end - 30 * DAY_MS;
    periods.push({ start, end, label: `${shortDate(start)} – ${shortDate(end - DAY_MS)}` });
  }
  return periods;
}

/** Sum of `value` over items whose `at` falls inside each period. */
export function bucketSeries<T>(
  items: readonly T[],
  periods: readonly DashboardPeriod[],
  at: (item: T) => number | null,
  value: (item: T) => number = () => 1,
): number[] {
  const out = periods.map(() => 0);
  for (const item of items) {
    const ms = at(item);
    if (ms == null || !Number.isFinite(ms)) continue;
    const i = periods.findIndex((p) => ms >= p.start && ms < p.end);
    if (i >= 0) out[i] = (out[i] ?? 0) + value(item);
  }
  return out;
}

/**
 * How many of `items` existed at the END of each period — for a stock, not a
 * flow. Occupancy is a stock: what matters is how many leases were signed by
 * the last day of August, not how many were signed during it.
 */
export function stockSeries<T>(
  items: readonly T[],
  periods: readonly DashboardPeriod[],
  from: (item: T) => number | null,
  until: (item: T) => number | null = () => null,
): number[] {
  return periods.map((p) => {
    const cut = Math.min(p.end, Number.MAX_SAFE_INTEGER);
    let n = 0;
    for (const item of items) {
      const a = from(item);
      if (a == null || !Number.isFinite(a) || a >= cut) continue;
      const b = until(item);
      if (b != null && Number.isFinite(b) && b < cut) continue;
      n += 1;
    }
    return n;
  });
}

export type KpiDelta = {
  /** Signed change against the previous period, in the metric's own unit. */
  change: number;
  /** "up" reads well, "down" reads badly, unless `invert`. */
  direction: "up" | "down" | "flat";
  /** "+2 vs last month", "−$340 vs last week", "No change vs last month". */
  label: string;
};

/**
 * The change between the last two values of a series, worded for a card.
 *
 * `format` writes the magnitude ("$340", "2", "4 pts"); `previousLabel` is the
 * baseline's name. `invert` is for metrics where a rise is the bad direction
 * (open requests) so the tone follows the meaning, not the sign.
 */
export function kpiDelta(
  series: readonly number[],
  format: (n: number) => string,
  previousLabel: string,
  invert = false,
): KpiDelta | null {
  if (series.length < 2) return null;
  const current = series[series.length - 1]!;
  const previous = series[series.length - 2]!;
  const change = current - previous;
  if (change === 0) return { change, direction: "flat", label: `No change vs ${previousLabel}` };
  const rose = change > 0;
  const good = invert ? !rose : rose;
  return {
    change,
    direction: good ? "up" : "down",
    label: `${rose ? "+" : "−"}${format(Math.abs(change))} vs ${previousLabel}`,
  };
}

/** Parses "$1,160.00" or "1160" to a number; anything else is 0. */
export function moneyToNumber(label: string | undefined | null): number {
  if (!label) return 0;
  const n = Number(String(label).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/** Whole-dollar USD, "$1,160". */
export function usdWhole(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

/** "3 days", "1 day", "today" — how long ago `ms` was. */
export function ageLabel(ms: number, nowMs: number): string {
  const days = Math.floor((nowMs - ms) / DAY_MS);
  if (days <= 0) return "today";
  if (days === 1) return "1 day";
  if (days < 30) return `${days} days`;
  const months = Math.floor(days / 30);
  return months === 1 ? "1 month" : `${months} months`;
}

/**
 * Epoch ms of an ISO timestamp or a `YYYY-MM-DD` wall date, or null.
 *
 * A bare date is a day in the manager's own calendar, not midnight UTC — read
 * as UTC, "2026-09-01" lands on the evening of Aug 31 in Seattle and a rent
 * due on the 1st gets counted in the wrong month.
 */
export function toMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const wall = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const ms = wall
    ? new Date(Number(wall[1]), Number(wall[2]) - 1, Number(wall[3])).getTime()
    : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}
