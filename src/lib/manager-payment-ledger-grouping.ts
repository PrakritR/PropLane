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
  clusterRowsByResident,
  residentClusterKey,
  residentClusterLabel,
  type ResidentCluster,
} from "@/lib/resident-row-clustering";

export type ManagerPaymentResidentCluster = ResidentCluster<DemoManagerPaymentLedgerRow>;

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
  return clusterRowsByResident(rows, (row) => row.propertyName);
}
