import { dollarsToCents } from "@/lib/reports/money";
import {
  ownerMonthKeys,
  type OwnerMonthRow,
  type OwnerPropertySummary,
  type OwnerSummary,
  type OwnerUnitRow,
} from "@/lib/property-owner/projection";

/**
 * The pure half of the owner summary: manager-report rows in, the redacted
 * owner projection out. Money is read back from the SAME formatted cells the
 * manager's Profitability report prints (`dollarsToCents` on `centsToUsd`
 * output is exact), so an owner's net for a house and month cannot differ from
 * the manager's by construction.
 *
 * Fields are copied by name. Nothing is spread from an input row.
 */

/** A `queryProfitability` row (groupBy "month") — only the fields read here. */
export type ProfitabilityMonthRow = {
  monthKey: string;
  propertyId: string;
  grossRent: string;
  otherIncome: string;
  processingFees: string;
  vendorPayouts: string;
  commsCost: string;
  expenses: string;
  net: string;
};

export type OwnerHouseInputs = {
  propertyId: string;
  label: string;
  profitability: ProfitabilityMonthRow[];
  /** Rent charged (due) per month, cents, keyed YYYY-MM. */
  rentDueByMonth: Record<string, number>;
  units: number;
  occupied: number;
  unitRows?: OwnerUnitRow[];
};

export function profitabilityRowFromCells(row: Record<string, unknown>): ProfitabilityMonthRow {
  return {
    monthKey: String(row.monthKey ?? ""),
    propertyId: String(row.propertyId ?? ""),
    grossRent: String(row.grossRent ?? "$0.00"),
    otherIncome: String(row.otherIncome ?? "$0.00"),
    processingFees: String(row.processingFees ?? "$0.00"),
    vendorPayouts: String(row.vendorPayouts ?? "$0.00"),
    commsCost: String(row.commsCost ?? "$0.00"),
    expenses: String(row.expenses ?? "$0.00"),
    net: String(row.net ?? "$0.00"),
  };
}

function monthRow(month: string, row: ProfitabilityMonthRow | undefined, rentDueCents: number): OwnerMonthRow {
  if (!row) {
    return {
      month,
      rentCollectedCents: 0,
      rentDueCents,
      otherIncomeCents: 0,
      feesCents: 0,
      repairsServicesCents: 0,
      netCents: 0,
    };
  }
  return {
    month,
    rentCollectedCents: dollarsToCents(row.grossRent),
    rentDueCents,
    otherIncomeCents: dollarsToCents(row.otherIncome),
    feesCents: dollarsToCents(row.processingFees),
    // Vendor payouts and logged expenses collapse to one total. The owner sees
    // that money went to repairs and services, never to whom or for what.
    repairsServicesCents: dollarsToCents(row.vendorPayouts) + dollarsToCents(row.expenses),
    // `comms` is portfolio-wide and is never attributed to one house, so it is
    // already 0 here; it stays inside `net` because net is the manager's figure.
    netCents: dollarsToCents(row.net),
  };
}

export function buildOwnerPropertySummary(period: string, house: OwnerHouseInputs): OwnerPropertySummary {
  const months = ownerMonthKeys(period, 12);
  const byMonth = new Map(house.profitability.filter((r) => r.propertyId === house.propertyId).map((r) => [r.monthKey, r]));
  const rows = months.map((m) => monthRow(m, byMonth.get(m), house.rentDueByMonth[m] ?? 0));
  const current = rows[rows.length - 1]!;
  const year = period.slice(0, 4);
  const netYtdCents = rows.filter((r) => r.month.startsWith(year)).reduce((sum, r) => sum + r.netCents, 0);
  return {
    propertyId: house.propertyId,
    label: house.label,
    units: house.units,
    occupied: house.occupied,
    rentCollectedCents: current.rentCollectedCents,
    rentDueCents: current.rentDueCents,
    netCents: current.netCents,
    netYtdCents,
    months: rows,
    ...(house.unitRows ? { unitRows: house.unitRows.map((u) => ({ unit: u.unit, status: u.status, rentCents: u.rentCents, leaseEnd: u.leaseEnd })) } : {}),
  };
}

export function buildOwnerSummary(period: string, houses: OwnerHouseInputs[]): OwnerSummary {
  const properties = houses.map((h) => buildOwnerPropertySummary(period, h));
  const months = ownerMonthKeys(period, 12);
  const chart = months.map((month, i) => {
    let income = 0;
    let expenses = 0;
    for (const p of properties) {
      const m = p.months[i]!;
      income += m.rentCollectedCents + m.otherIncomeCents;
      expenses += m.feesCents + m.repairsServicesCents;
    }
    return { month, incomeCents: income, expensesCents: expenses };
  });
  return {
    period,
    totals: {
      netMonthCents: properties.reduce((s, p) => s + p.netCents, 0),
      netYtdCents: properties.reduce((s, p) => s + p.netYtdCents, 0),
      rentCollectedCents: properties.reduce((s, p) => s + p.rentCollectedCents, 0),
      rentDueCents: properties.reduce((s, p) => s + p.rentDueCents, 0),
      units: properties.reduce((s, p) => s + p.units, 0),
      occupied: properties.reduce((s, p) => s + p.occupied, 0),
    },
    chart,
    properties,
  };
}
