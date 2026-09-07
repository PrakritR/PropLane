/**
 * Profitability report (PRP-278): pure aggregation.
 *
 * Every figure here is a sum over rows the caller already read — ledger payment
 * entries, logged expenses, paid vendor payouts, communication usage events.
 * Nothing is estimated or recomputed from a rate card; a category whose rows
 * could not be sourced (an unreadable plan for the communication allowance, a
 * property filter that cannot scope a portfolio-wide cost) is reported as 0
 * and says so in `meta.source_*`, never as a guessed number.
 *
 * The database reads live in `profitability.server.ts`; this module is kept
 * free of I/O so the per-property / per-month / net arithmetic is testable on
 * fixture rows.
 */

import { systemChartAccountByCode } from "@/lib/reports/chart-of-accounts-store";
import { centsToUsd } from "@/lib/reports/money";
import type { ReportColumn, ReportResult, ReportRow } from "@/lib/reports/types";

export const PROFITABILITY_REPORT_ID = "profitability";

/** Label for rows that no property can own (portfolio-wide costs, unassigned entries). */
export const PROFITABILITY_UNASSIGNED_LABEL = "Portfolio (unassigned)";

export type ProfitabilityGroupBy = "property" | "month";

/** A `ledger_entries` row with `entry_type = 'payment'`. */
export type ProfitabilityLedgerPayment = {
  propertyId: string | null;
  /** `posted_date`, YYYY-MM-DD. */
  postedDate: string;
  categoryCode: string;
  amountCents: number;
  /** Stripe's processing fee debited from the MANAGER — 0 on Connect destination charges. */
  stripeFeeCents: number | null;
  /** The destination transfer: `charge.amount − application_fee`. Null until Stripe enrichment ran. */
  netCents: number | null;
};

/** A `manager_expense_entries` row. */
export type ProfitabilityExpense = {
  propertyId: string | null;
  /** `expense_date`, YYYY-MM-DD. */
  expenseDate: string;
  amountCents: number;
};

/** A `vendor_payouts` row with `status = 'paid'`, resolved to its work order's property. */
export type ProfitabilityVendorPayout = {
  propertyId: string | null;
  /** When the payout settled (`updated_at`), ISO timestamp. */
  paidAt: string;
  amountCents: number;
};

/** A `manager_comms_usage_events` row. */
export type ProfitabilityCommsUsageEvent = {
  /** ISO timestamp. Billing periods are UTC calendar months, same as the allowance gate. */
  createdAt: string;
  totalCents: number;
};

export type ProfitabilityCommsAllowance =
  /** The plan was read; `cents` null means the plan is uncapped (nothing is ever billed). */
  | { readable: true; cents: number | null }
  /** The plan could not be read — the billable amount cannot be derived. */
  | { readable: false };

export type ProfitabilityInput = {
  /** Inclusive YYYY-MM-DD range; months are derived from it. */
  from: string;
  to: string;
  groupBy: ProfitabilityGroupBy;
  ledgerPayments: ProfitabilityLedgerPayment[];
  expenses: ProfitabilityExpense[];
  vendorPayouts: ProfitabilityVendorPayout[];
  commsUsage: ProfitabilityCommsUsageEvent[];
  commsAllowance: ProfitabilityCommsAllowance;
  /**
   * Set when the caller scoped the report to one property. Communication cost
   * is portfolio-wide (usage events carry no property), so a scoped report
   * reports it as 0 with a note rather than attributing all of it to one house.
   */
  propertyFilterActive?: boolean;
  propertyLabel: (propertyId: string) => string;
  /** Override the chart-of-accounts classification (tests). */
  incomeClass?: (categoryCode: string) => IncomeClass;
};

export type IncomeClass = "rent" | "other" | "excluded";

/**
 * Which income column a payment lands in. Rent-kind charges all map to
 * `rent_income` (`categoryCodeForChargeKind`); every other INCOME account is
 * other income; liabilities such as security deposits are not income at all
 * and are excluded, matching `queryIncomeStatement`.
 */
export function defaultIncomeClass(categoryCode: string): IncomeClass {
  if (categoryCode === "rent_income") return "rent";
  const account = systemChartAccountByCode(categoryCode);
  if (account && account.accountType !== "income") return "excluded";
  return "other";
}

export type ProfitabilityCells = {
  grossRentCents: number;
  otherIncomeCents: number;
  processingFeeCents: number;
  vendorPayoutCents: number;
  commsCostCents: number;
  expenseCents: number;
};

export function emptyProfitabilityCells(): ProfitabilityCells {
  return {
    grossRentCents: 0,
    otherIncomeCents: 0,
    processingFeeCents: 0,
    vendorPayoutCents: 0,
    commsCostCents: 0,
    expenseCents: 0,
  };
}

export function profitabilityNetCents(cells: ProfitabilityCells): number {
  return (
    cells.grossRentCents +
    cells.otherIncomeCents -
    cells.processingFeeCents -
    cells.vendorPayoutCents -
    cells.commsCostCents -
    cells.expenseCents
  );
}

function hasAnyActivity(cells: ProfitabilityCells): boolean {
  return (
    cells.grossRentCents !== 0 ||
    cells.otherIncomeCents !== 0 ||
    cells.processingFeeCents !== 0 ||
    cells.vendorPayoutCents !== 0 ||
    cells.commsCostCents !== 0 ||
    cells.expenseCents !== 0
  );
}

/**
 * The processing fee the MANAGER bore on one payment.
 *
 * `stripe_fee_cents` is Stripe's own fee when it was debited from the manager
 * (0 on the Connect destination charges PropLane creates today). On top of
 * that, when the manager absorbs the resident's service fee it is retained as
 * the `application_fee_amount`, so the transfer (`net_cents`) is short of the
 * charge by exactly that fee. When the resident paid it, `net_cents` equals
 * the charge amount and the difference is 0 — the resident's fee is never
 * counted here. A row Stripe has not enriched yet (`net_cents` null) carries
 * no fee evidence and contributes 0.
 */
export function managerBorneFeeCents(row: Pick<ProfitabilityLedgerPayment, "amountCents" | "stripeFeeCents" | "netCents">): number {
  const stripeFee = Math.max(0, Number(row.stripeFeeCents) || 0);
  const retained =
    row.netCents === null || row.netCents === undefined
      ? 0
      : Math.max(0, (Number(row.amountCents) || 0) - (Number(row.netCents) || 0));
  return stripeFee + retained;
}

/** Every YYYY-MM between two YYYY-MM-DD dates, oldest first (empty when reversed). */
export function profitabilityMonthKeys(from: string, to: string): string[] {
  const start = monthKeyOfDate(from);
  const end = monthKeyOfDate(to);
  if (!start || !end || start > end) return [];
  const keys: string[] = [];
  let [year, month] = start.split("-").map(Number) as [number, number];
  for (let guard = 0; guard < 600; guard += 1) {
    const key = `${year}-${String(month).padStart(2, "0")}`;
    keys.push(key);
    if (key === end) break;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return keys;
}

/** `YYYY-MM` of a YYYY-MM-DD date or ISO timestamp, by prefix — no timezone shift. */
export function monthKeyOfDate(value: string | null | undefined): string | null {
  const text = String(value ?? "").trim();
  return /^\d{4}-\d{2}/.test(text) ? text.slice(0, 7) : null;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function profitabilityMonthLabel(monthKey: string): string {
  const [year, month] = monthKey.split("-");
  const name = MONTH_NAMES[Number(month) - 1];
  return name ? `${name} ${year}` : monthKey;
}

/**
 * Billable communication cost per month: usage value above the plan's included
 * allowance, 0 while within it (`allowances.ts`). The allowance applies per
 * UTC calendar month, the same period `monthToDateUsageCents` meters.
 */
export function commsBillableCentsByMonth(
  events: ProfitabilityCommsUsageEvent[],
  months: string[],
  allowance: ProfitabilityCommsAllowance,
): Map<string, number> {
  const out = new Map<string, number>(months.map((m) => [m, 0]));
  if (!allowance.readable || allowance.cents === null) return out;
  const used = new Map<string, number>();
  for (const event of events) {
    const key = monthKeyOfDate(event.createdAt);
    if (!key || !out.has(key)) continue;
    used.set(key, (used.get(key) ?? 0) + Math.max(0, Math.round(Number(event.totalCents) || 0)));
  }
  for (const key of months) {
    out.set(key, Math.max(0, (used.get(key) ?? 0) - allowance.cents));
  }
  return out;
}

type Bucket = { monthKey: string; propertyId: string | null; cells: ProfitabilityCells };

const UNASSIGNED_KEY = " unassigned";

function bucketKey(groupBy: ProfitabilityGroupBy, monthKey: string, propertyId: string | null): string {
  const property = propertyId ?? UNASSIGNED_KEY;
  return groupBy === "month" ? `${monthKey}|${property}` : property;
}

export type ProfitabilitySources = {
  grossRent: string;
  otherIncome: string;
  processingFees: string;
  vendorPayouts: string;
  commsCost: string;
  expenses: string;
};

export function profitabilitySources(input: Pick<ProfitabilityInput, "commsAllowance" | "propertyFilterActive">): ProfitabilitySources {
  let commsCost: string;
  if (!input.commsAllowance.readable) {
    commsCost = "0 — the plan could not be read, so the included allowance is unknown and no billable amount can be derived from manager_comms_usage_events.";
  } else if (input.propertyFilterActive) {
    commsCost = "0 — communication usage is portfolio-wide (manager_comms_usage_events carry no property), so it is not attributed to a single property.";
  } else if (input.commsAllowance.cents === null) {
    commsCost = "0 — the plan is uncapped, so no communication usage is billed.";
  } else {
    commsCost = `manager_comms_usage_events.total_cents per UTC month above the plan's included allowance (${centsToUsd(input.commsAllowance.cents)}); 0 while within it.`;
  }
  return {
    grossRent: "ledger_entries payment rows in rent_income (rent, first/last/prorated rent, stay totals), by posted_date.",
    otherIncome: "ledger_entries payment rows in every other income account (late fees, utilities, application and move-in fees, manual income); deposits and other liabilities excluded.",
    processingFees: "ledger_entries payment rows: stripe_fee_cents plus the application fee retained from the manager's transfer (amount_cents − net_cents when positive). 0 when the resident or PropLane bore the fee.",
    vendorPayouts: "vendor_payouts rows with status paid, by settlement time; property via the work order's property_id.",
    commsCost,
    expenses: "manager_expense_entries by expense_date, including expenses created from services and paid bills.",
  };
}

export type ProfitabilityBuildResult = {
  report: ReportResult;
  months: string[];
  propertyCount: number;
  sources: ProfitabilitySources;
};

export function buildProfitabilityReport(input: ProfitabilityInput): ProfitabilityBuildResult {
  const months = profitabilityMonthKeys(input.from, input.to);
  const monthSet = new Set(months);
  const incomeClass = input.incomeClass ?? defaultIncomeClass;
  const buckets = new Map<string, Bucket>();

  const bucketFor = (monthKey: string, propertyId: string | null): ProfitabilityCells => {
    const id = propertyId && propertyId.trim() ? propertyId.trim() : null;
    const key = bucketKey(input.groupBy, monthKey, id);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { monthKey, propertyId: id, cells: emptyProfitabilityCells() };
      buckets.set(key, bucket);
    }
    return bucket.cells;
  };

  for (const row of input.ledgerPayments) {
    const monthKey = monthKeyOfDate(row.postedDate);
    if (!monthKey || !monthSet.has(monthKey)) continue;
    const kind = incomeClass(row.categoryCode);
    const cells = bucketFor(monthKey, row.propertyId);
    const amount = Math.max(0, Number(row.amountCents) || 0);
    if (kind === "rent") cells.grossRentCents += amount;
    else if (kind === "other") cells.otherIncomeCents += amount;
    cells.processingFeeCents += managerBorneFeeCents(row);
  }

  for (const row of input.expenses) {
    const monthKey = monthKeyOfDate(row.expenseDate);
    if (!monthKey || !monthSet.has(monthKey)) continue;
    bucketFor(monthKey, row.propertyId).expenseCents += Math.max(0, Number(row.amountCents) || 0);
  }

  for (const row of input.vendorPayouts) {
    const monthKey = monthKeyOfDate(row.paidAt);
    if (!monthKey || !monthSet.has(monthKey)) continue;
    bucketFor(monthKey, row.propertyId).vendorPayoutCents += Math.max(0, Number(row.amountCents) || 0);
  }

  if (!input.propertyFilterActive) {
    const comms = commsBillableCentsByMonth(input.commsUsage, months, input.commsAllowance);
    for (const [monthKey, cents] of comms) {
      if (cents > 0) bucketFor(monthKey, null).commsCostCents += cents;
    }
  }

  const active = [...buckets.values()].filter((b) => hasAnyActivity(b.cells));
  const labelOf = (propertyId: string | null) =>
    propertyId ? input.propertyLabel(propertyId) : PROFITABILITY_UNASSIGNED_LABEL;

  active.sort((a, b) => {
    if (input.groupBy === "month" && a.monthKey !== b.monthKey) return b.monthKey.localeCompare(a.monthKey);
    // Unassigned last; otherwise by label.
    if ((a.propertyId === null) !== (b.propertyId === null)) return a.propertyId === null ? 1 : -1;
    return labelOf(a.propertyId).localeCompare(labelOf(b.propertyId), undefined, { sensitivity: "base" });
  });

  const totals = emptyProfitabilityCells();
  const rows: ReportRow[] = active.map((bucket) => {
    totals.grossRentCents += bucket.cells.grossRentCents;
    totals.otherIncomeCents += bucket.cells.otherIncomeCents;
    totals.processingFeeCents += bucket.cells.processingFeeCents;
    totals.vendorPayoutCents += bucket.cells.vendorPayoutCents;
    totals.commsCostCents += bucket.cells.commsCostCents;
    totals.expenseCents += bucket.cells.expenseCents;
    return {
      ...(input.groupBy === "month" ? { month: profitabilityMonthLabel(bucket.monthKey), monthKey: bucket.monthKey } : {}),
      property: labelOf(bucket.propertyId),
      propertyId: bucket.propertyId ?? "",
      ...cellsToRow(bucket.cells),
    };
  });

  const columns: ReportColumn[] = [
    ...(input.groupBy === "month" ? [{ key: "month", label: "Month" } satisfies ReportColumn] : []),
    { key: "property", label: "Property" },
    { key: "grossRent", label: "Gross rent", align: "right", format: "money" },
    { key: "otherIncome", label: "Other income", align: "right", format: "money" },
    { key: "processingFees", label: "Processing fees", align: "right", format: "money" },
    { key: "vendorPayouts", label: "Vendor payouts", align: "right", format: "money" },
    { key: "commsCost", label: "Communication", align: "right", format: "money" },
    { key: "expenses", label: "Expenses", align: "right", format: "money" },
    { key: "net", label: "Net", align: "right", format: "money" },
  ];

  const propertyCount = new Set(active.map((b) => b.propertyId).filter((id): id is string => Boolean(id))).size;
  const sources = profitabilitySources(input);

  const report: ReportResult = {
    id: PROFITABILITY_REPORT_ID,
    title: "Profitability",
    columns,
    rows,
    totals: {
      ...(input.groupBy === "month" ? { month: "Total", monthKey: "" } : {}),
      property: input.groupBy === "month" ? "" : "Total",
      propertyId: "",
      ...cellsToRow(totals),
    },
    meta: {
      from: input.from,
      to: input.to,
      groupBy: input.groupBy,
      months: months.length,
      propertyCount,
      source_grossRent: sources.grossRent,
      source_otherIncome: sources.otherIncome,
      source_processingFees: sources.processingFees,
      source_vendorPayouts: sources.vendorPayouts,
      source_commsCost: sources.commsCost,
      source_expenses: sources.expenses,
    },
  };

  return { report, months, propertyCount, sources };
}

function cellsToRow(cells: ProfitabilityCells): ReportRow {
  return {
    grossRent: centsToUsd(cells.grossRentCents),
    otherIncome: centsToUsd(cells.otherIncomeCents),
    processingFees: centsToUsd(cells.processingFeeCents),
    vendorPayouts: centsToUsd(cells.vendorPayoutCents),
    commsCost: centsToUsd(cells.commsCostCents),
    expenses: centsToUsd(cells.expenseCents),
    net: centsToUsd(profitabilityNetCents(cells)),
  };
}
