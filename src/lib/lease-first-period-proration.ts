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
    dueDateLabel: `By ${reminderDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`,
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

/** "September 2026" — the calendar month a prorated amount belongs to, for lease copy. */
export function prorationMonthLabel(date: string | undefined): string {
  const parsed = parseFlexibleLocalDate(date ?? "");
  if (!parsed) return "";
  // Pinned to en-US rather than the ambient locale: this string is printed into an
  // executed lease document, so it must not change with the server's locale.
  return parsed.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

/**
 * One partial-last-month amount, in the SAME two branches the ledger bills in
 * (`lastMonthChargeForLeaseEnd` in `household-charges.ts` calls this).
 *
 * A daily-priced room bills its partial last month per day regardless of `prorateMethod`;
 * an explicit `daily_rate` proration method does too when it carries a rate. Everything
 * else takes the monthly amount times the day factor.
 */
export function proratedLastMonthAmount(
  monthlyAmount: number,
  proration: LeaseBoundaryProration,
  method?: "auto" | "daily_rate",
  dailyRate?: number,
  dailyBasisRate?: number,
): { amount: number; useDailyRate: boolean; effectiveDailyRate: number } {
  const effectiveDailyRate = dailyBasisRate && dailyBasisRate > 0 ? dailyBasisRate : (dailyRate ?? 0);
  const useDailyRate =
    (dailyBasisRate != null && dailyBasisRate > 0) ||
    (method === "daily_rate" && dailyRate != null && dailyRate > 0);
  const amount = useDailyRate
    ? Number((proration.billableDays * effectiveDailyRate).toFixed(2))
    : Number((monthlyAmount * proration.factor).toFixed(2));
  return { amount, useDailyRate, effectiveDailyRate };
}

export type ProratedLastMonthComputeInput = {
  monthlyRent: number;
  monthlyUtilities: number;
  leaseEnd: string | undefined;
  method?: "auto" | "daily_rate";
  dailyRentRate?: number;
  dailyUtilitiesRate?: number;
  /** Headline daily rate when the room itself is priced by the day. */
  dailyBasisRate?: number;
  /**
   * The ledger creates NO last-month charge for a daily-priced stay that ends inside its
   * own first month — the first-period charge already covers the whole term. The document
   * has to skip it on exactly the same condition or it states a charge nobody bills.
   */
  endsInsideFirstMonth?: boolean;
  /** Ledger amounts, when a snapshot exists, so the document matches what actually bills. */
  ledgerProratedLastMonthRent?: number;
  ledgerProratedLastMonthUtilities?: number;
};

export type ProratedLastMonthTotals = {
  applies: boolean;
  proratedRent: number;
  proratedUtilities: number;
  total: number;
  billableDays: number;
  daysInMonth: number;
  /** Day-count basis, e.g. "1/31 days through lease end". */
  label: string;
  /** The ledger's own due date for these charges (a week before the lease ends). */
  dueDateLabel?: string;
  /** Calendar month the amounts belong to, e.g. "December 2027". */
  monthLabel: string;
};

const NO_LAST_MONTH_PRORATION: ProratedLastMonthTotals = {
  applies: false,
  proratedRent: 0,
  proratedUtilities: 0,
  total: 0,
  billableDays: 0,
  daysInMonth: 0,
  label: "full last month",
  monthLabel: "",
};

/**
 * Dollar amounts for the partial LAST calendar month of a lease — the "last month's rent"
 * line a lease summary quotes. Mirrors `lastMonthChargeForLeaseEnd`'s math exactly so the
 * document and the household charges can never disagree.
 */
export function computeProratedLastMonthTotals(
  input: ProratedLastMonthComputeInput,
): ProratedLastMonthTotals {
  if (input.endsInsideFirstMonth) return NO_LAST_MONTH_PRORATION;
  const proration = leaseEndProration(input.leaseEnd);
  if (!proration.prorated) return NO_LAST_MONTH_PRORATION;

  const rent =
    input.monthlyRent > 0 || (input.dailyBasisRate ?? 0) > 0
      ? proratedLastMonthAmount(
          input.monthlyRent,
          proration,
          input.method,
          input.dailyRentRate,
          input.dailyBasisRate,
        ).amount
      : 0;
  const utilities =
    input.monthlyUtilities > 0 &&
    (input.method !== "daily_rate" || Boolean(input.dailyUtilitiesRate && input.dailyUtilitiesRate > 0))
      ? proratedLastMonthAmount(input.monthlyUtilities, proration, input.method, input.dailyUtilitiesRate)
          .amount
      : 0;

  const proratedRent = input.ledgerProratedLastMonthRent ?? rent;
  const proratedUtilities = input.ledgerProratedLastMonthUtilities ?? utilities;
  if (proratedRent <= 0 && proratedUtilities <= 0) return NO_LAST_MONTH_PRORATION;

  return {
    applies: true,
    proratedRent,
    proratedUtilities,
    total: Number((proratedRent + proratedUtilities).toFixed(2)),
    billableDays: proration.billableDays,
    daysInMonth: proration.daysInMonth,
    label: proration.label,
    dueDateLabel: proration.dueDateLabel,
    monthLabel: prorationMonthLabel(input.leaseEnd),
  };
}
