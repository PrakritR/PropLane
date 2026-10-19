import { OPS_REPORTS } from "./site/product-mock/fixtures-popups-ops";
import { PROPERTY_ROWS, RESIDENT_ROWS } from "./site/product-mock/fixtures";
import { dollarsToCents } from "@/lib/reports/money";
import type { OwnerStatements, OwnerSummary } from "@/lib/property-owner/projection";

/** Only the aggregate fields already shared in the manager's sample owner report. */
export function homeOwnerReport(propertyId = "") {
  const report = OPS_REPORTS.find((item) => item.id === "owner-statement")!;
  return report.rows.map(([label, income, expenses, distribution]) => ({
    propertyId: PROPERTY_ROWS.find((property) => property.title === label)!.id,
    label,
    incomeCents: dollarsToCents(income),
    expensesCents: dollarsToCents(expenses),
    distributionCents: dollarsToCents(distribution),
  })).filter((row) => !propertyId || row.propertyId === propertyId);
}

/** The September 2025 statement already drawn by the manager's sample Reports. */
export function homeOwnerStatements(propertyId = ""): OwnerStatements {
  const report = homeOwnerReport(propertyId);
  const houses = report.map(({ propertyId, label }) => ({ propertyId, label }));
  return {
    houses,
    rows: houses.length ? [{ month: "2025-09", houses: houses.length, distributionCents: report.reduce((sum, row) => sum + row.distributionCents, 0) }] : [],
  };
}

/** A local sample export, never the live statement/PDF endpoint. */
export function homeOwnerStatementCsv(propertyId = ""): string {
  const rows = homeOwnerReport(propertyId).map((row) => [row.label, (row.incomeCents / 100).toFixed(2), (row.expensesCents / 100).toFixed(2), (row.distributionCents / 100).toFixed(2)]);
  return [["Sample statement · September 2025"], ["Property", "Income (USD)", "Expenses (USD)", "Owner share (USD)"], ...rows]
    .map((row) => row.map((value) => `"${value.replaceAll('"', '""')}"`).join(",")).join("\r\n");
}

/** Only supported aggregate fields. YTD and rent due remain unknown in the sample view. */
export function homeOwnerSummary(): OwnerSummary {
  const report = homeOwnerReport();
  const properties = report.map((row) => ({
    propertyId: row.propertyId,
    label: row.label,
    units: PROPERTY_ROWS.find((property) => property.id === row.propertyId)!.rooms,
    occupied: new Set(RESIDENT_ROWS.filter((resident) => resident.tab === "current" && resident.place.endsWith(` · ${row.label}`)).map((resident) => resident.place)).size,
    rentCollectedCents: row.incomeCents,
    rentDueCents: 0,
    netCents: row.distributionCents,
    netYtdCents: 0,
    months: [],
  }));
  const sum = (key: "netCents" | "rentCollectedCents" | "units" | "occupied") => properties.reduce((total, row) => total + row[key], 0);
  return {
    period: "2025-09",
    totals: { netMonthCents: sum("netCents"), netYtdCents: 0, rentCollectedCents: sum("rentCollectedCents"), rentDueCents: 0, units: sum("units"), occupied: sum("occupied") },
    chart: [{ month: "2025-09", incomeCents: sum("rentCollectedCents"), expensesCents: report.reduce((total, row) => total + row.expensesCents, 0) }],
    properties,
  };
}
