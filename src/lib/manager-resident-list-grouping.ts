import {
  applicationHasGroup,
  normalizeGroupId,
  type ApplicationGroup,
} from "@/lib/rental-application/application-groups";
import { isMultiMemberHouseholdGroup } from "@/lib/rental-application/application-list-grouping";
import {
  clusterRowsByResident,
  type ResidentCluster,
} from "@/lib/resident-row-clustering";
import type { ManagerResidentListRow } from "@/lib/manager-resident-list";

export type ManagerResidentListRowWithGroup = ManagerResidentListRow & {
  groupId: string;
};

export type ManagerResidentListCluster =
  | { kind: "resident"; cluster: ResidentCluster<ManagerResidentListRow> }
  | {
      kind: "household";
      groupId: string;
      group: ApplicationGroup | null;
      rows: ManagerResidentListRow[];
    };

function rowGroupId(row: ManagerResidentListRowWithGroup): string {
  if (!row.groupId.trim()) return "";
  return normalizeGroupId(row.groupId);
}

type ResidentListUnit =
  | { kind: "resident"; rows: ManagerResidentListRowWithGroup[] }
  | { kind: "household"; groupId: string; rows: ManagerResidentListRowWithGroup[] };

/**
 * Group residents by shared application Group ID when the household has multiple
 * members portfolio-wide; otherwise fall back to one cluster per resident identity.
 * Preserves the caller's row order between units.
 */
export function buildResidentListClusters(
  rows: readonly ManagerResidentListRowWithGroup[],
  groups: Map<string, ApplicationGroup>,
): ManagerResidentListCluster[] {
  const householdByGroup = new Map<string, ManagerResidentListRowWithGroup[]>();
  const singles: ManagerResidentListRowWithGroup[] = [];

  for (const row of rows) {
    const gid = rowGroupId(row);
    if (!gid) {
      singles.push(row);
      continue;
    }
    const group = groups.get(gid) ?? null;
    if (!isMultiMemberHouseholdGroup(group)) {
      singles.push(row);
      continue;
    }
    const list = householdByGroup.get(gid);
    if (list) list.push(row);
    else householdByGroup.set(gid, [row]);
  }

  const units: ResidentListUnit[] = [];
  const emittedHouseholds = new Set<string>();

  for (const row of rows) {
    const gid = rowGroupId(row);
    const group = gid ? groups.get(gid) ?? null : null;
    if (gid && isMultiMemberHouseholdGroup(group)) {
      if (emittedHouseholds.has(gid)) continue;
      emittedHouseholds.add(gid);
      units.push({ kind: "household", groupId: gid, rows: householdByGroup.get(gid) ?? [row] });
      continue;
    }
    units.push({ kind: "resident", rows: [row] });
  }

  const clusters: ManagerResidentListCluster[] = [];

  for (const unit of units) {
    if (unit.kind === "household") {
      clusters.push({
        kind: "household",
        groupId: unit.groupId,
        group: groups.get(unit.groupId) ?? null,
        rows: unit.rows,
      });
      continue;
    }

    const identityClusters = clusterRowsByResident(
      unit.rows.map((row) => ({ ...row, residentName: row.name, residentEmail: row.email })),
      (entry) => entry.propertyLabel || null,
    );
    for (const cluster of identityClusters) {
      clusters.push({ kind: "resident", cluster });
    }
  }

  return clusters;
}
