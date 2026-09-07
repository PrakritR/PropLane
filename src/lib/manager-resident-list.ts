import {
  clusterRowsByResident,
  type ResidentCluster,
} from "@/lib/resident-row-clustering";

export type ManagerResidentListRow = {
  id: string;
  name: string;
  email: string;
  propertyId: string;
  propertyLabel: string;
  roomLabel: string;
  leaseStart: string;
  /**
   * Where this person is in the application — "Incomplete", "Pending review",
   * "Approved". Only the Potential stage sets it: a current tenant's row is
   * about a tenancy, and repeating "Approved" on every one of them is noise.
   */
  statusLabel?: string;
};

export type ManagerResidentListCluster = ResidentCluster<ManagerResidentListRow>;

export function residentHousingMeta(row: ManagerResidentListRow, includeProperty: boolean): string {
  return [row.roomLabel, includeProperty ? row.propertyLabel : null].filter(Boolean).join(" · ") || "—";
}

/** Group residents by identity — same rule as Tours, Payments, and Applications. */
export function clusterManagerResidentListRows(
  rows: readonly ManagerResidentListRow[],
): ManagerResidentListCluster[] {
  return clusterRowsByResident(
    rows.map((row) => ({
      ...row,
      residentName: row.name,
      residentEmail: row.email,
    })),
    (row) => row.propertyLabel || null,
  );
}
