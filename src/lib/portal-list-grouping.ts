import {
  clusterRowsByProperty,
  clusterRowsByResident,
  type PortalListGroupMode,
  type PropertyCluster,
  type PropertyClusterFields,
  type ResidentCluster,
  type ResidentIdentityFields,
} from "@/lib/resident-row-clustering";

export type { PortalListGroupMode, PropertyCluster, ResidentCluster };

export const PORTAL_LIST_GROUP_MODES = ["resident", "house"] as const;

export const PORTAL_LIST_GROUP_MODE_LABELS: Record<PortalListGroupMode, string> = {
  resident: "Sort by resident",
  house: "Sort by house",
};

export const DEFAULT_PORTAL_LIST_GROUP_MODE: PortalListGroupMode = "resident";

export function portalListGroupModeActiveCount(
  groupMode: PortalListGroupMode,
  defaultMode: PortalListGroupMode = DEFAULT_PORTAL_LIST_GROUP_MODE,
): number {
  return groupMode === defaultMode ? 0 : 1;
}

type ClusterableRow = ResidentIdentityFields & PropertyClusterFields;

/** Cluster list rows under resident or house headers, preserving caller order. */
export function clusterPortalListRows<T extends ClusterableRow>(
  rows: readonly T[],
  mode: PortalListGroupMode,
  propertyLabelOf?: (row: T) => string | null | undefined,
): ResidentCluster<T>[] | PropertyCluster<T>[] {
  if (mode === "house") {
    return clusterRowsByProperty(
      rows.map((row) => ({
        ...row,
        propertyLabel: propertyLabelOf?.(row) ?? row.propertyLabel,
      })),
    );
  }
  return clusterRowsByResident(rows, propertyLabelOf);
}

export function isPropertyClusterList<T>(
  mode: PortalListGroupMode,
  clusters: ResidentCluster<T>[] | PropertyCluster<T>[],
): clusters is PropertyCluster<T>[] {
  return mode === "house";
}
