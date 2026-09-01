import type { DemoManagerOutgoingPaymentRow } from "@/data/demo-portal";
import {
  clusterPortalListRows,
  type PortalListGroupMode,
} from "@/lib/portal-list-grouping";
import type { PropertyCluster, ResidentCluster } from "@/lib/resident-row-clustering";

export type ManagerOutgoingPayeeCluster = ResidentCluster<DemoManagerOutgoingPaymentRow>;
export type ManagerOutgoingPropertyCluster = PropertyCluster<DemoManagerOutgoingPaymentRow>;

export function clusterManagerOutgoingPaymentRowsByMode(
  rows: DemoManagerOutgoingPaymentRow[],
  mode: "resident",
): ManagerOutgoingPayeeCluster[];
export function clusterManagerOutgoingPaymentRowsByMode(
  rows: DemoManagerOutgoingPaymentRow[],
  mode: "house",
): ManagerOutgoingPropertyCluster[];
export function clusterManagerOutgoingPaymentRowsByMode(
  rows: DemoManagerOutgoingPaymentRow[],
  mode: PortalListGroupMode,
): ManagerOutgoingPayeeCluster[] | ManagerOutgoingPropertyCluster[];
export function clusterManagerOutgoingPaymentRowsByMode(
  rows: DemoManagerOutgoingPaymentRow[],
  mode: PortalListGroupMode,
): ManagerOutgoingPayeeCluster[] | ManagerOutgoingPropertyCluster[] {
  return clusterPortalListRows(
    rows.map((row) => ({
      ...row,
      residentName: row.payeeLabel?.trim() || "—",
      residentEmail: "",
      propertyLabel: row.propertyName,
      propertyId: row.propertyId,
    })),
    mode,
    (row) => row.propertyName,
  );
}
