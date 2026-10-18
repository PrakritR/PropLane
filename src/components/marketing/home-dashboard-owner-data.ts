import { OPS_REPORTS } from "./site/product-mock/fixtures-popups-ops";
import { PROPERTY_ROWS } from "./site/product-mock/fixtures";
import { dollarsToCents } from "@/lib/reports/money";
import type { OwnerStatements } from "@/lib/property-owner/projection";

/** The September 2025 statement already drawn by the manager's sample Reports. */
export function homeOwnerStatements(): OwnerStatements {
  const report = OPS_REPORTS.find((item) => item.id === "owner-statement")!;
  const houses = report.rows.map(([label]) => ({ propertyId: PROPERTY_ROWS.find((property) => property.title === label)!.id, label }));
  return {
    houses,
    rows: [{ month: "2025-09", houses: houses.length, distributionCents: report.rows.reduce((sum, row) => sum + dollarsToCents(row[3]), 0) }],
  };
}
