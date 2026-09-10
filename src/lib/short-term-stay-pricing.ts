import { formatIsoDateInput, parseFlexibleLocalDate } from "@/lib/rental-application/lease-dates";
import { parseMoneyAmount } from "@/lib/parse-money";

/** Check-out date for a stay that bills `nights` checkout-exclusive nights from check-in. */
export function shortTermCheckoutDate(leaseStart: string | undefined | null, nights: number): string | null {
  const start = parseFlexibleLocalDate(leaseStart);
  if (!start || !(nights > 0)) return null;
  const checkout = new Date(start.getFullYear(), start.getMonth(), start.getDate() + nights);
  return formatIsoDateInput(checkout);
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Whole calendar days between two local dates, immune to daylight-saving shifts.
 *
 * Differencing the raw local timestamps is NOT safe: a span crossing a fall-back transition
 * gains 3,600,000 ms, which pushed the old `Math.ceil(delta / MS_PER_DAY)` up by a whole day
 * and billed the guest an extra night. Normalizing both ends to UTC midnight removes the
 * offset before dividing.
 */
function calendarDaysBetween(start: Date, end: Date): number {
  const s = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  const e = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
  return Math.round((e - s) / MS_PER_DAY);
}

/** Checkout-exclusive night count (check-out morning is not billed). */
export function shortTermStayNightCount(
  leaseStart: string | undefined | null,
  leaseEnd: string | undefined | null,
): number | null {
  const start = parseFlexibleLocalDate(leaseStart);
  const end = parseFlexibleLocalDate(leaseEnd);
  if (!start || !end) return null;
  // Checkout-exclusive, per main, and counted in whole calendar days so a stay crossing a
  // daylight-saving fall-back is not billed an extra night.
  const nights = Math.max(1, calendarDaysBetween(start, end));
  return Number.isFinite(nights) && nights > 0 ? nights : null;
}

/**
 * The billable span when a lease starts and ends inside ONE calendar month without covering
 * the whole month, else null. That is exactly when the charge ledger bills a daily-priced
 * placement ONCE, up front, as a single stay total (`endsInsideFirstMonth` in
 * household-charges.ts), and its `billableDays / daysInMonth` is the same factor the ledger
 * prorates the stay's utilities by, so the document can quote the figure that is charged.
 *
 * This is the line between a short STAY and a tenancy that merely happens to be priced by the
 * day. A daily-priced room on a 3-month or month-to-month lease bills monthly, recurring, so
 * it is a tenancy and must keep the full residential lease. Without this bound, a billing-basis
 * flag would silently decide the legal document type and hand a year-long resident an
 * agreement that disclaims tenancy.
 */
export function intraMonthStaySpan(
  leaseStart: string | undefined | null,
  leaseEnd: string | undefined | null,
): { billableDays: number; daysInMonth: number } | null {
  const start = parseFlexibleLocalDate(leaseStart);
  const end = parseFlexibleLocalDate(leaseEnd);
  if (!start || !end) return null;
  if (start.getFullYear() !== end.getFullYear() || start.getMonth() !== end.getMonth()) return null;
  const daysInMonth = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
  if (!Number.isFinite(daysInMonth) || daysInMonth <= 0) return null;
  const billableDays = Math.min(daysInMonth, end.getDate()) - start.getDate() + 1;
  if (billableDays <= 0 || billableDays >= daysInMonth) return null;
  return { billableDays, daysInMonth };
}

/** @see intraMonthStaySpan */
export function isIntraMonthStay(
  leaseStart: string | undefined | null,
  leaseEnd: string | undefined | null,
): boolean {
  return intraMonthStaySpan(leaseStart, leaseEnd) !== null;
}

export function shortTermNightlyRate(raw: string | undefined | null): number {
  const amount = parseMoneyAmount(String(raw ?? "").trim());
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

/**
 * How a stay splits into whole weeks and leftover nights (PRP-463).
 *
 * A manager who quotes a weekly rate means it: twelve nights is one week plus five
 * nights, not twelve nights at the nightly rate. The weekly rate is a REAL price and is
 * deliberately cheaper than seven nights, so billing nightly across a long stay
 * overcharges the guest against the rate they were quoted.
 *
 * With no weekly rate — or a stay shorter than a week — this is the nightly maths it has
 * always been, so nothing already booked changes.
 */
export function shortTermStaySplit(
  nights: number,
  weeklyRate: number | undefined,
): { weeks: number; nights: number } {
  if (!(nights > 0)) return { weeks: 0, nights: 0 };
  if (!(weeklyRate && weeklyRate > 0) || nights < 7) return { weeks: 0, nights };
  return { weeks: Math.floor(nights / 7), nights: nights % 7 };
}

export function shortTermStayTotalAmount(
  nightlyRate: number,
  nights: number,
  weeklyRate?: number,
): number {
  if (!(nights > 0)) return 0;
  const split = shortTermStaySplit(nights, weeklyRate);
  if (split.weeks > 0) {
    // A leftover night still needs a nightly rate; without one the weeks alone are billed
    // rather than inventing a price for the remainder.
    const remainder = nightlyRate > 0 ? split.nights * nightlyRate : 0;
    return Number((split.weeks * (weeklyRate ?? 0) + remainder).toFixed(2));
  }
  if (!(nightlyRate > 0)) return 0;
  return Number((nightlyRate * nights).toFixed(2));
}

export function shortTermStayChargeTitle(
  nights: number,
  nightlyRate: number,
  weeklyRate?: number,
): string {
  const money = (n: number) => (n % 1 === 0 ? `$${n}` : `$${n.toFixed(2)}`);
  const split = shortTermStaySplit(nights, weeklyRate);
  if (split.weeks > 0) {
    const weekLabel = split.weeks === 1 ? "1 week" : `${split.weeks} weeks`;
    const parts = [`${weekLabel} × ${money(weeklyRate ?? 0)}`];
    if (split.nights > 0) {
      parts.push(`${split.nights === 1 ? "1 night" : `${split.nights} nights`} × ${money(nightlyRate)}`);
    }
    return `Stay total (${parts.join(" + ")})`;
  }
  const nightLabel = nights === 1 ? "1 night" : `${nights} nights`;
  return `Stay total (${nightLabel} × ${money(nightlyRate)})`;
}

/** Inverse of {@link shortTermStayChargeTitle} for manager payment edits. */
export function parseShortTermStayChargeTitle(
  title: string,
): { nights: number; nightlyRate: number; weeks?: number; weeklyRate?: number } | null {
  const trimmed = title.trim();
  const weekly = trimmed.match(
    /^Stay total \((\d+) weeks? × (\$[\d.]+)(?: \+ (\d+) nights? × (\$[\d.]+))?\)$/i,
  );
  if (weekly) {
    const weeks = Number(weekly[1]);
    const weeklyRate = parseMoneyAmount(weekly[2] ?? "");
    const nights = weekly[3] ? Number(weekly[3]) : 0;
    const nightlyRate = weekly[4] ? parseMoneyAmount(weekly[4]) : 0;
    if (!(weeks > 0) || !(weeklyRate > 0)) return null;
    return { nights: weeks * 7 + nights, nightlyRate, weeks, weeklyRate };
  }
  const match = trimmed.match(/^Stay total \((\d+) nights? × (\$[\d.]+)\)$/i);
  if (!match) return null;
  const nights = Number(match[1]);
  const nightlyRate = parseMoneyAmount(match[2] ?? "");
  if (!(nights > 0) || !(nightlyRate > 0)) return null;
  return { nights, nightlyRate };
}
