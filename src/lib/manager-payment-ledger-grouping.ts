/**
 * Payments' resident grouping — now a thin binding over the shared rule in
 * `resident-row-clustering.ts`, which Tours and Services use too.
 *
 * These exports are kept because the payments surface and its tests already name them; the
 * identity logic itself deliberately no longer lives here. Two copies of "which resident is this
 * row about" is how the same person ends up heading differently-shaped groups on two tabs.
 */
import type { DemoManagerPaymentLedgerRow } from "@/data/demo-portal";
import {
  clusterPortalListRows,
  type PortalListGroupMode,
} from "@/lib/portal-list-grouping";
import {
  residentClusterKey,
  residentClusterLabel,
  type PropertyCluster,
  type ResidentCluster,
} from "@/lib/resident-row-clustering";

export type ManagerPaymentResidentCluster = ResidentCluster<DemoManagerPaymentLedgerRow>;
export type ManagerPaymentPropertyCluster = PropertyCluster<DemoManagerPaymentLedgerRow>;

export function paymentLedgerResidentLabel(
  row: Pick<DemoManagerPaymentLedgerRow, "residentName" | "residentEmail">,
): string {
  return residentClusterLabel({ id: "", ...row });
}

export function residentPaymentLedgerGroupKey(
  row: Pick<DemoManagerPaymentLedgerRow, "id" | "residentEmail" | "residentName">,
): string {
  return residentClusterKey(row);
}

/** Group ledger rows under one resident header, preserving the incoming sort order. */
export function clusterManagerPaymentLedgerRows(
  rows: DemoManagerPaymentLedgerRow[],
): ManagerPaymentResidentCluster[] {
  return clusterManagerPaymentLedgerRowsByMode(rows, "resident");
}

// Mirrors the overloads on `clusterPortalListRows`: a literal mode resolves to
// the single cluster shape it produces, so callers need no cast.
export function clusterManagerPaymentLedgerRowsByMode(
  rows: DemoManagerPaymentLedgerRow[],
  mode: "resident",
): ManagerPaymentResidentCluster[];
export function clusterManagerPaymentLedgerRowsByMode(
  rows: DemoManagerPaymentLedgerRow[],
  mode: "house",
): ManagerPaymentPropertyCluster[];
export function clusterManagerPaymentLedgerRowsByMode(
  rows: DemoManagerPaymentLedgerRow[],
  mode: PortalListGroupMode,
): ManagerPaymentResidentCluster[] | ManagerPaymentPropertyCluster[];
export function clusterManagerPaymentLedgerRowsByMode(
  rows: DemoManagerPaymentLedgerRow[],
  mode: PortalListGroupMode,
): ManagerPaymentResidentCluster[] | ManagerPaymentPropertyCluster[] {
  return clusterPortalListRows(
    rows.map((row) => ({
      ...row,
      propertyLabel: row.propertyName,
    })),
    mode,
    (row) => row.propertyName,
  );
}
