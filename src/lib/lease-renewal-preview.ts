/**
 * What a resident will actually be billed under a proposed renewal, computed
 * BEFORE they confirm it.
 *
 * The renewal flow deliberately does not touch charges until both parties sign
 * (`applySignedLeaseRenewal`), so until now the only thing the resident saw was
 * a toast promising that payments would update later. This is the missing half:
 * the same schedule, stated up front.
 *
 * The partial first and last months come from the SHARED proration helpers the
 * ledger and the lease document already use, so a preview can never quote a
 * number the ledger would not go on to bill.
 */
import {
  computeProratedFirstMonthTotals,
  computeProratedLastMonthTotals,
} from "@/lib/lease-first-period-proration";
import { parseFlexibleLocalDate } from "@/lib/rental-application/lease-dates";
import { SHORT_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";

export type RenewalPaymentLine = {
  id: string;
  label: string;
  /** When the charge lands, in the resident's words ("Due Oct 1"). */
  detail: string;
  amount: number | null;
  /** A recurring line stands for many months, so it is never added into a total. */
  recurring?: boolean;
};

export type RenewalPaymentPreview = {
  /** False when there is not enough information to state anything truthful. */
  applies: boolean;
  lines: RenewalPaymentLine[];
  /** Present only for a term with a known end — month-to-month has no total. */
  total: number | null;
  note: string;
};

const EMPTY: RenewalPaymentPreview = { applies: false, lines: [], total: null, note: "" };

export function formatRenewalUsd(amount: number): string {
  return `$${amount.toFixed(2).replace(/\.00$/, "")}`;
}

function monthLabel(iso: string): string {
  const d = parseFlexibleLocalDate(iso);
  if (!d) return "";
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function dayLabel(iso: string): string {
  const d = parseFlexibleLocalDate(iso);
  if (!d) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** First of the month on or after `iso` — when the first FULL month's rent is due. */
function firstFullMonthDue(iso: string): string {
  const d = parseFlexibleLocalDate(iso);
  if (!d) return "";
  const next = d.getDate() === 1 ? d : new Date(d.getFullYear(), d.getMonth() + 1, 1);
  return next.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Whole calendar months billed at the full rate between start and end, inclusive. */
function fullMonthCount(leaseStart: string, leaseEnd: string): number {
  const start = parseFlexibleLocalDate(leaseStart);
  const end = parseFlexibleLocalDate(leaseEnd);
  if (!start || !end || end < start) return 0;
  const firstFull = start.getDate() === 1 ? start : new Date(start.getFullYear(), start.getMonth() + 1, 1);
  const lastDayOfEndMonth = new Date(end.getFullYear(), end.getMonth() + 1, 0).getDate();
  const lastFullExclusive =
    end.getDate() === lastDayOfEndMonth
      ? new Date(end.getFullYear(), end.getMonth() + 1, 1)
      : new Date(end.getFullYear(), end.getMonth(), 1);
  const months =
    (lastFullExclusive.getFullYear() - firstFull.getFullYear()) * 12 +
    (lastFullExclusive.getMonth() - firstFull.getMonth());
  return Math.max(0, months);
}

export type RenewalPreviewInput = {
  leaseTerm: string;
  leaseStart: string;
  /** Empty means month-to-month — open-ended, so there is no total. */
  leaseEnd: string;
  /** Rent for the RENEWAL. Null means the resident left it blank to keep current rent. */
  monthlyRent: number | null;
  /** The rent in force today, used when the renewal keeps it. */
  currentMonthlyRent: number | null;
  monthlyUtilities?: number;
};

/**
 * The rent/utility schedule a renewal creates, as lines a resident can read.
 *
 * Short-term stays are deliberately NOT previewed: they are priced per night by
 * a different path (`resolveStayPricing`), and quoting a monthly schedule for
 * one would state a number nothing bills.
 */
export function leaseRenewalPaymentPreview(input: RenewalPreviewInput): RenewalPaymentPreview {
  const term = input.leaseTerm.trim();
  if (!term || !input.leaseStart) return EMPTY;
  if (term === SHORT_TERM_LEASE_TERM) {
    return {
      applies: false,
      lines: [],
      total: null,
      note: "Short stays are priced per night — your manager confirms the total when they review this request.",
    };
  }

  const rent = input.monthlyRent ?? input.currentMonthlyRent ?? null;
  if (rent == null || !Number.isFinite(rent) || rent <= 0) return EMPTY;
  const utilities = input.monthlyUtilities && input.monthlyUtilities > 0 ? input.monthlyUtilities : 0;
  const isMonthToMonth = term === "Month-to-Month" || !input.leaseEnd;

  const lines: RenewalPaymentLine[] = [];
  const first = computeProratedFirstMonthTotals({
    monthlyRent: rent,
    monthlyUtilities: utilities,
    leaseStart: input.leaseStart,
    leaseEnd: input.leaseEnd || undefined,
  });
  if (first.applies && first.total > 0) {
    lines.push({
      id: "first",
      label: `Partial ${monthLabel(input.leaseStart)}`,
      detail: `From ${dayLabel(input.leaseStart)}`,
      amount: first.total,
    });
  }

  const monthly = rent + utilities;
  if (isMonthToMonth) {
    lines.push({
      id: "monthly",
      label: "Monthly rent",
      detail: `Due the 1st, starting ${firstFullMonthDue(input.leaseStart)}`,
      amount: monthly,
      recurring: true,
    });
    return {
      applies: true,
      lines,
      total: null,
      note: "Month-to-month has no end date, so there is no term total — billing continues until either side gives notice.",
    };
  }

  const last = computeProratedLastMonthTotals({
    monthlyRent: rent,
    monthlyUtilities: utilities,
    leaseEnd: input.leaseEnd,
  });
  const months = fullMonthCount(input.leaseStart, input.leaseEnd);
  if (months > 0) {
    lines.push({
      id: "monthly",
      label: `Monthly rent × ${months}`,
      detail: `Due the 1st, starting ${firstFullMonthDue(input.leaseStart)}`,
      amount: monthly,
      recurring: true,
    });
  }
  if (last.applies && last.total > 0) {
    lines.push({
      id: "last",
      label: `Partial ${last.monthLabel}`,
      detail: `Through ${dayLabel(input.leaseEnd)} · ${last.label}`,
      amount: last.total,
    });
  }

  const total =
    (first.applies ? first.total : 0) + monthly * months + (last.applies ? last.total : 0);

  return {
    applies: lines.length > 0,
    lines,
    total: Number(total.toFixed(2)),
    note: "Your deposit and any move-in fees already settled are not charged again.",
  };
}
