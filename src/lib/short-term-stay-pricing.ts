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

/** Stay-length tiers (captain's pricing system): 1-6 nights nightly, 7-27 weekly, 28+ monthly. */
export const STAY_WEEKLY_TIER_MIN_NIGHTS = 7;
export const STAY_MONTHLY_TIER_MIN_NIGHTS = 28;
/** A monthly-rate stay is prorated per night over this many nights, so 30 nights = the monthly rate. */
export const STAY_MONTH_NIGHTS = 30;
/** The weekly rate when a room has none: six nights at the nightly rate. */
export const STAY_DEFAULT_WEEKLY_NIGHTS = 6;

export type ShortStayTier = "nightly" | "weekly" | "monthly";

const roundCents = (n: number) => Number(n.toFixed(2));
const positive = (n: number | undefined | null): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

/** The weekly rate that applies: the room's own, else 6 x its nightly rate. */
export function shortTermEffectiveWeeklyRate(nightlyRate: number, weeklyRate?: number): number | undefined {
  if (positive(weeklyRate)) return weeklyRate;
  return positive(nightlyRate) ? roundCents(nightlyRate * STAY_DEFAULT_WEEKLY_NIGHTS) : undefined;
}

/** Which tier prices a stay of `nights`. Monthly needs a monthly rate; without one 28+ stays stay weekly. */
export function shortTermStayTier(nights: number, monthlyRate?: number): ShortStayTier {
  if (nights >= STAY_MONTHLY_TIER_MIN_NIGHTS && positive(monthlyRate)) return "monthly";
  if (nights >= STAY_WEEKLY_TIER_MIN_NIGHTS) return "weekly";
  return "nightly";
}

export function shortTermStayTierLabel(tier: ShortStayTier): string {
  return tier === "monthly" ? "Monthly rate" : tier === "weekly" ? "Weekly rate" : "Nightly";
}

/**
 * Informational split into whole weeks and leftover nights. Pricing no longer bills this way
 * (weekly stays are prorated per night).
 */
export function shortTermStaySplit(
  nights: number,
  weeklyRate: number | undefined,
): { weeks: number; nights: number } {
  if (!(nights > 0)) return { weeks: 0, nights: 0 };
  if (!(weeklyRate && weeklyRate > 0) || nights < 7) return { weeks: 0, nights };
  return { weeks: Math.floor(nights / 7), nights: nights % 7 };
}

/** Whether the rates on hand can price a stay of `nights` (weekly/monthly-only rates cover their own tier). */
export function shortTermStayCanBePriced(
  nightlyRate: number,
  nights: number,
  weeklyRate?: number,
  monthlyRate?: number,
): boolean {
  if (!Number.isFinite(nights) || nights <= 0 || !Number.isInteger(nights)) return false;
  if (positive(nightlyRate)) return true;
  if (positive(weeklyRate) && nights >= STAY_WEEKLY_TIER_MIN_NIGHTS) return true;
  return positive(monthlyRate) && nights >= STAY_MONTHLY_TIER_MIN_NIGHTS;
}

/**
 * The one stay-total decision. 1-6 nights: nightly x n. 7-27 nights: weekly x n/7 (weekly
 * defaults to 6 x nightly). 28+ nights: monthly x n/30 when the room has a monthly rate.
 */
export function shortTermStayTotalAmount(
  nightlyRate: number,
  nights: number,
  weeklyRate?: number,
  monthlyRate?: number,
): number {
  if (!shortTermStayCanBePriced(nightlyRate, nights, weeklyRate, monthlyRate)) return 0;
  const tier = shortTermStayTier(nights, monthlyRate);
  if (tier === "monthly") return roundCents((monthlyRate! * nights) / STAY_MONTH_NIGHTS);
  if (tier === "weekly") {
    const weekly = shortTermEffectiveWeeklyRate(nightlyRate, weeklyRate);
    if (weekly) return roundCents((weekly * nights) / 7);
  }
  return positive(nightlyRate) ? roundCents(nightlyRate * nights) : 0;
}

const stayMoney = (n: number) => (n % 1 === 0 ? `$${n}` : `$${n.toFixed(2)}`);

export function shortTermStayChargeTitle(
  nights: number,
  nightlyRate: number,
  weeklyRate?: number,
  monthlyRate?: number,
): string {
  const nightLabel = nights === 1 ? "1 night" : `${nights} nights`;
  const tier = shortTermStayTier(nights, monthlyRate);
  if (tier === "monthly") {
    return `Stay total (${nightLabel} × ${stayMoney(monthlyRate!)}/month, ${shortTermStayTierLabel(tier)})`;
  }
  const weekly = tier === "weekly" ? shortTermEffectiveWeeklyRate(nightlyRate, weeklyRate) : undefined;
  if (weekly) return `Stay total (${nightLabel} × ${stayMoney(weekly)}/week, ${shortTermStayTierLabel(tier)})`;
  return `Stay total (${nightLabel} × ${stayMoney(nightlyRate)})`;
}

/** The plain "N nights × $rate" title, with no tier (a daily-priced tenancy bills days x rate). */
export function shortTermStayNightlyTitle(nights: number, nightlyRate: number): string {
  return `Stay total (${nights === 1 ? "1 night" : `${nights} nights`} × ${stayMoney(nightlyRate)})`;
}

/** UI line for quotes and checkout: the tier label ahead of the math. */
export function shortTermStayTierNote(
  nights: number,
  nightlyRate: number,
  weeklyRate?: number,
  monthlyRate?: number,
): string {
  const title = shortTermStayChargeTitle(nights, nightlyRate, weeklyRate, monthlyRate);
  const inner = title.replace(/^Stay total \(/, "").replace(/\)$/, "");
  const tier = shortTermStayTier(nights, monthlyRate);
  return tier === "nightly" ? `${shortTermStayTierLabel(tier)}: ${inner}` : inner;
}

/** Inverse of {@link shortTermStayChargeTitle} for manager payment edits. */
export function parseShortTermStayChargeTitle(
  title: string,
): { nights: number; nightlyRate: number; weeks?: number; weeklyRate?: number; monthlyRate?: number } | null {
  const trimmed = title.trim();
  const tiered = trimmed.match(
    /^Stay total \((\d+) nights? × (\$[\d.]+)\/(week|month), (?:Weekly|Monthly) rate\)$/i,
  );
  if (tiered) {
    const nights = Number(tiered[1]);
    const rate = parseMoneyAmount(tiered[2] ?? "");
    if (!(nights > 0) || !(rate > 0)) return null;
    return tiered[3]!.toLowerCase() === "month"
      ? { nights, nightlyRate: 0, monthlyRate: rate }
      : { nights, nightlyRate: 0, weeklyRate: rate };
  }
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
