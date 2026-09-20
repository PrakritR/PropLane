/**
 * Historical rent lines for an imported lease: each calendar month from start
 * through `throughDate` is paid; later months through the lease end (or the
 * month after `throughDate` when the stay is open-ended) stay pending.
 * Amount is sheet rent + utilities. Listing advertised rent is never read.
 */

export type PaidLeaseHistoryMonth = {
  yearMonth: string;
  dueDate: string;
  status: "paid" | "pending";
  amountCents: number;
  title: string;
};

function yearMonthOf(iso: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return null;
  return `${m[1]}-${m[2]}`;
}

function firstOfMonth(yearMonth: string): string {
  return `${yearMonth}-01`;
}

function nextYearMonth(yearMonth: string): string {
  const [y, m] = yearMonth.split("-").map(Number);
  const next = new Date(y, m - 1 + 1, 1);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`;
}

function monthTitle(yearMonth: string): string {
  const [y, m] = yearMonth.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleString("en-US", { month: "short", year: "numeric" });
}

export function paidLeaseHistoryMonths(input: {
  start: string;
  end?: string | null;
  throughDate: string;
  rentCents: number;
  utilitiesCents?: number;
  monthToMonth?: boolean;
}): PaidLeaseHistoryMonth[] {
  const rent = Number(input.rentCents);
  const utilities = Number(input.utilitiesCents ?? 0);
  if (!Number.isFinite(rent) || rent <= 0) return [];
  const amountCents = Math.round(rent + (Number.isFinite(utilities) && utilities > 0 ? utilities : 0));

  const startYm = yearMonthOf(input.start);
  const throughYm = yearMonthOf(input.throughDate);
  if (!startYm || !throughYm) return [];

  const endYm = input.end ? yearMonthOf(input.end) : null;
  const lastYm = endYm ?? nextYearMonth(throughYm);
  if (lastYm < startYm) return [];

  const out: PaidLeaseHistoryMonth[] = [];
  for (let ym = startYm; ym <= lastYm; ym = nextYearMonth(ym)) {
    out.push({
      yearMonth: ym,
      dueDate: firstOfMonth(ym),
      status: ym <= throughYm ? "paid" : "pending",
      amountCents,
      title: `Rent · ${monthTitle(ym)}`,
    });
    if (ym === lastYm) break;
    if (out.length > 36) break;
  }
  return out;
}
