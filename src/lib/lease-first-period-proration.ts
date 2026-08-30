import { parseFlexibleLocalDate } from "@/lib/rental-application/lease-dates";
import { intraMonthStaySpan } from "@/lib/short-term-stay-pricing";

export type LeaseBoundaryProration = {
  prorated: boolean;
  factor: number;
  billableDays: number;
  daysInMonth: number;
  label: string;
  dueDateLabel?: string;
};

/** Proration from lease start through the end of that calendar month (flexible date input). */
export function leaseStartProration(leaseStart: string | undefined): LeaseBoundaryProration {
  if (!leaseStart?.trim()) {
    return { prorated: false, factor: 1, billableDays: 0, daysInMonth: 0, label: "full first month" };
  }
  const start = parseFlexibleLocalDate(leaseStart);
  if (!start) {
    return { prorated: false, factor: 1, billableDays: 0, daysInMonth: 0, label: "full first month" };
  }
  const year = start.getFullYear();
  const month = start.getMonth() + 1;
  const day = start.getDate();
  const daysInMonth = new Date(year, month, 0).getDate();
  if (!Number.isFinite(daysInMonth) || daysInMonth <= 0 || day <= 1) {
    return { prorated: false, factor: 1, billableDays: daysInMonth, daysInMonth, label: "full first month" };
  }
  const billableDays = Math.max(1, daysInMonth - day + 1);
  return {
    prorated: true,
    factor: billableDays / daysInMonth,
    billableDays,
    daysInMonth,
    label: `${billableDays}/${daysInMonth} days from lease start`,
  };
}

/** Proration for the final partial calendar month when the lease ends before month end. */
export function leaseEndProration(leaseEnd: string | undefined): LeaseBoundaryProration {
  if (!leaseEnd?.trim()) {
    return { prorated: false, factor: 1, billableDays: 0, daysInMonth: 0, label: "full last month" };
  }
  const end = parseFlexibleLocalDate(leaseEnd);
  if (!end) {
    return { prorated: false, factor: 1, billableDays: 0, daysInMonth: 0, label: "full last month" };
  }
  const year = end.getFullYear();
  const month = end.getMonth() + 1;
  const day = end.getDate();
  const daysInMonth = new Date(year, month, 0).getDate();
  if (!Number.isFinite(daysInMonth) || daysInMonth <= 0 || day >= daysInMonth) {
    return { prorated: false, factor: 1, billableDays: daysInMonth, daysInMonth, label: "full last month" };
  }
  const leaseEndDate = new Date(year, month - 1, day);
  const reminderDate = new Date(leaseEndDate.getTime() - 7 * 24 * 60 * 60 * 1000);
  return {
    prorated: true,
    factor: day / daysInMonth,
    billableDays: day,
    daysInMonth,
    label: `${day}/${daysInMonth} days through lease end`,
    dueDateLabel: `By ${reminderDate.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`,
  };
}

/**
 * Proration for the FIRST billed period. Normally that is the partial month from the
 * lease start; for a lease that also ends in the same month it is the whole lease term.
 */
export function leaseFirstPeriodProration(
  leaseStart: string | undefined,
  leaseEnd: string | undefined,
  collapseIntraMonth: boolean,
): LeaseBoundaryProration {
  const span = collapseIntraMonth ? intraMonthStaySpan(leaseStart, leaseEnd) : null;
  if (!span) return leaseStartProration(leaseStart);
  return {
    prorated: true,
    factor: span.billableDays / span.daysInMonth,
    billableDays: span.billableDays,
    daysInMonth: span.daysInMonth,
    label: `${span.billableDays}/${span.daysInMonth} days of lease term`,
  };
}

export type ProratedFirstMonthComputeInput = {
  monthlyRent: number;
  monthlyUtilities: number;
  leaseStart: string;
  leaseEnd?: string;
  method?: "auto" | "daily_rate";
  dailyRentRate?: number;
  dailyUtilitiesRate?: number;
  /** Daily-basis rent bills per day; only utilities prorate in the first-period display. */
  utilitiesOnly?: boolean;
  ledgerProratedRent?: number;
  ledgerProratedUtilities?: number;
};

export type ProratedFirstMonthTotals = {
  proratedRent: number;
  proratedUtilities: number;
  total: number;
  applies: boolean;
};

/** Dollar amounts for the prorated first month (lease summary + prorated section). */
export function computeProratedFirstMonthTotals(input: ProratedFirstMonthComputeInput): ProratedFirstMonthTotals {
  const utilitiesOnly = input.utilitiesOnly === true;
  const rent = utilitiesOnly ? 0 : input.monthlyRent;
  const utils = input.monthlyUtilities;
  const start = parseFlexibleLocalDate(input.leaseStart);
  if (!start || (!rent && !utilitiesOnly) || (utilitiesOnly && !(utils > 0))) {
    return { proratedRent: 0, proratedUtilities: 0, total: 0, applies: false };
  }

  const span = utilitiesOnly ? intraMonthStaySpan(input.leaseStart, input.leaseEnd ?? "") : null;
  const day = start.getDate();
  const hasLedgerProration =
    (input.ledgerProratedRent != null && input.ledgerProratedRent > 0) ||
    (input.ledgerProratedUtilities != null && input.ledgerProratedUtilities > 0);
  if (!span && day === 1 && !hasLedgerProration) {
    return { proratedRent: 0, proratedUtilities: 0, total: 0, applies: false };
  }

  const dim = span ? span.daysInMonth : new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
  const remaining = span ? span.billableDays : dim - day + 1;
  const useManual = input.method === "daily_rate" && (input.dailyRentRate ?? 0) > 0;
  const useManualUtils = input.method === "daily_rate" && (input.dailyUtilitiesRate ?? 0) > 0;

  let proratedRent =
    utilitiesOnly || !(rent > 0)
      ? 0
      : useManual
        ? Math.round((input.dailyRentRate ?? 0) * remaining * 100) / 100
        : Math.round((rent / dim) * remaining * 100) / 100;
  let proratedUtilities =
    utils > 0
      ? useManualUtils
        ? Math.round((input.dailyUtilitiesRate ?? 0) * remaining * 100) / 100
        : Math.round((utils / dim) * remaining * 100) / 100
      : 0;

  if (input.ledgerProratedRent != null || input.ledgerProratedUtilities != null) {
    proratedRent = utilitiesOnly ? 0 : (input.ledgerProratedRent ?? 0);
    proratedUtilities =
      input.ledgerProratedUtilities != null && input.ledgerProratedUtilities > 0
        ? input.ledgerProratedUtilities
        : utilitiesOnly
          ? (input.ledgerProratedUtilities ?? 0)
          : proratedUtilities;
  }

  return {
    proratedRent,
    proratedUtilities,
    total: proratedRent + proratedUtilities,
    applies: true,
  };
}
