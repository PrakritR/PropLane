import type { DemoApplicantRow } from "@/data/demo-portal";
import type { ApplicationListTabId } from "@/lib/portal-detail-routes";
import { getRoomChoiceLabel } from "@/lib/rental-application/data";
import {
  applicationHasGroup,
  normalizeGroupId,
  type ApplicationGroup,
} from "@/lib/rental-application/application-groups";
import type { GroupRole } from "@/lib/rental-application/types";
import { applicationRowSortMs } from "@/lib/manager-application-list";

export type ApplicationListSortBucket = "approved" | "pending";

export type ApplicationListCluster =
  | { kind: "single"; row: DemoApplicantRow }
  | {
      kind: "household";
      groupId: string;
      group: ApplicationGroup | null;
      rows: DemoApplicantRow[];
    };

const ROLE_ORDER: Record<Exclude<GroupRole, null> | "none", number> = {
  first: 0,
  joining: 1,
  none: 2,
};

function rowGroupId(row: DemoApplicantRow): string {
  if (!applicationHasGroup(row.application)) return "";
  return normalizeGroupId(row.application?.groupId);
}

function roomSortKey(row: DemoApplicantRow): string {
  return (
    getRoomChoiceLabel(row.assignedRoomChoice?.trim() || row.application?.roomChoice1?.trim() || "") ||
    row.stage ||
    ""
  ).trim();
}

/** Row ordering within a manager/resident applications bucket (before household clustering). */
export function compareApplicationRowsForBucket(
  a: DemoApplicantRow,
  b: DemoApplicantRow,
  bucket: ApplicationListSortBucket,
): number {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  if (bucket === "approved") {
    const propertyCmp = collator.compare(a.property || "", b.property || "");
    if (propertyCmp !== 0) return propertyCmp;
    const roomCmp = collator.compare(roomSortKey(a), roomSortKey(b));
    if (roomCmp !== 0) return roomCmp;
  }
  const applicantCmp = collator.compare(a.name || "", b.name || "");
  if (applicantCmp !== 0) return applicantCmp;
  return collator.compare(a.id, b.id);
}

function sortRowsWithinBucket(rows: DemoApplicantRow[], bucket: ApplicationListSortBucket): DemoApplicantRow[] {
  return [...rows].sort((a, b) => compareApplicationRowsForBucket(a, b, bucket));
}

function sortHouseholdMembers(rows: DemoApplicantRow[]): DemoApplicantRow[] {
  return [...rows].sort((a, b) => {
    const ra = ROLE_ORDER[a.application?.groupRole ?? "none"];
    const rb = ROLE_ORDER[b.application?.groupRole ?? "none"];
    if (ra !== rb) return ra - rb;
    return compareApplicationRowsForBucket(a, b, "pending");
  });
}

function clusterLeadRow(rows: DemoApplicantRow[]): DemoApplicantRow {
  return sortHouseholdMembers(rows)[0] ?? rows[0]!;
}

/** Household card when the group has multiple members portfolio-wide, not only in this bucket. */
export function isMultiMemberHouseholdGroup(group: ApplicationGroup | null | undefined): boolean {
  if (!group) return false;
  if (group.totalCount > 1) return true;
  return (group.expectedSize ?? 0) > 1;
}

/**
 * Orders applications so group household members appear adjacent (organizer first),
 * while preserving the bucket's overall sort order between households and singles.
 */
export function orderApplicationRowsWithHouseholds(
  rows: DemoApplicantRow[],
  bucket: ApplicationListSortBucket,
): DemoApplicantRow[] {
  const byGroup = new Map<string, DemoApplicantRow[]>();
  const singles: DemoApplicantRow[] = [];

  for (const row of rows) {
    const gid = rowGroupId(row);
    if (!gid) {
      singles.push(row);
      continue;
    }
    const list = byGroup.get(gid);
    if (list) list.push(row);
    else byGroup.set(gid, [row]);
  }

  const sortedSingles = sortRowsWithinBucket(singles, bucket);

  type ClusterUnit = { lead: DemoApplicantRow; rows: DemoApplicantRow[]; groupId: string | null };
  const units: ClusterUnit[] = [
    ...sortedSingles.map((row) => ({ lead: row, rows: [row], groupId: null })),
    ...[...byGroup.entries()].map(([groupId, groupRows]) => ({
      lead: clusterLeadRow(groupRows),
      rows: sortHouseholdMembers(groupRows),
      groupId,
    })),
  ];

  units.sort((a, b) => compareApplicationRowsForBucket(a.lead, b.lead, bucket));

  return units.flatMap((unit) => unit.rows);
}

export function applicationListSortBucket(
  tab: "approved" | "pending" | "incomplete" | "rejected",
): ApplicationListSortBucket {
  return tab === "approved" ? "approved" : "pending";
}

/**
 * Build list clusters from bucket-scoped rows. A household renders as one visual group
 * whenever the group itself is multi-member portfolio-wide (more submissions than this
 * bucket shows, or a declared household size above one), so a member who is alone in
 * this bucket still clusters — only a genuine group of one stays a single row.
 */
export function buildApplicationListClusters(
  rows: DemoApplicantRow[],
  groups: Map<string, ApplicationGroup>,
  bucket: ApplicationListSortBucket,
): ApplicationListCluster[] {
  const ordered = orderApplicationRowsWithHouseholds(rows, bucket);
  const clusters: ApplicationListCluster[] = [];
  let index = 0;

  while (index < ordered.length) {
    const row = ordered[index]!;
    const gid = rowGroupId(row);
    if (!gid) {
      clusters.push({ kind: "single", row });
      index += 1;
      continue;
    }

    const householdRows: DemoApplicantRow[] = [];
    while (index < ordered.length && rowGroupId(ordered[index]!) === gid) {
      householdRows.push(ordered[index]!);
      index += 1;
    }

    if (householdRows.length === 1) {
      const group = groups.get(gid) ?? null;
      if (!isMultiMemberHouseholdGroup(group)) {
        clusters.push({ kind: "single", row: householdRows[0]! });
        continue;
      }
      clusters.push({
        kind: "household",
        groupId: gid,
        group,
        rows: householdRows,
      });
      continue;
    }

    clusters.push({
      kind: "household",
      groupId: gid,
      group: groups.get(gid) ?? null,
      rows: householdRows,
    });
  }

  return clusters;
}

function clusterLeadForSort(cluster: ApplicationListCluster): DemoApplicantRow | null {
  if (cluster.kind === "single") return cluster.row;
  return cluster.rows[0] ?? null;
}

/** Bucket sort for manager application list clusters (households sort by their lead row). */
export function sortApplicationListClustersForBucket(
  clusters: ApplicationListCluster[],
  tab: ApplicationListTabId,
): ApplicationListCluster[] {
  const bucket = applicationListSortBucket(tab);
  const sortKey = (cluster: ApplicationListCluster) => {
    const lead = clusterLeadForSort(cluster);
    if (!lead) return tab === "rejected" ? -Infinity : Infinity;
    if (tab === "rejected") return applicationRowSortMs(lead);
    if (tab === "approved") return 0;
    return applicationRowSortMs(lead);
  };

  const sorted = [...clusters].map((cluster) => {
    if (cluster.kind !== "household") return cluster;
    return {
      ...cluster,
      rows: [...cluster.rows].sort((a, b) => compareApplicationRowsForBucket(a, b, bucket)),
    };
  });

  if (tab === "approved") {
    sorted.sort((a, b) => {
      const leadA = clusterLeadForSort(a);
      const leadB = clusterLeadForSort(b);
      if (!leadA || !leadB) return 0;
      return compareApplicationRowsForBucket(leadA, leadB, bucket);
    });
    return sorted;
  }

  if (tab === "rejected") {
    sorted.sort((a, b) => sortKey(b) - sortKey(a));
    return sorted;
  }

  sorted.sort((a, b) => sortKey(a) - sortKey(b));
  return sorted;
}

/** Flat list order matching the manager applications grouped table. */
export function flattenApplicationListClusters(clusters: ApplicationListCluster[]): DemoApplicantRow[] {
  const rows: DemoApplicantRow[] = [];
  for (const cluster of clusters) {
    if (cluster.kind === "single") rows.push(cluster.row);
    else rows.push(...cluster.rows);
  }
  return rows;
}

/** Primary applications that may have linked co-signer submissions in this list. */
export function signerAppIdsForCosignerLookup(rows: DemoApplicantRow[]): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.application?.hasCosigner === "yes") ids.add(row.id);
  }
  return [...ids];
}
