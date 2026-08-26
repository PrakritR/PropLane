import type { DemoApplicantRow } from "@/data/demo-portal";
import type { ApplicationListTabId } from "@/lib/portal-detail-routes";
import { stripPropertyRoomCountSuffix } from "@/lib/portal-mobile-preview";
import { applicantDisplayName } from "@/lib/rental-application/applicant-name";
import {
  compareApplicationRowsForBucket,
  type ApplicationListSortBucket,
} from "@/lib/rental-application/application-list-grouping";
import {
  applicationStageDisplayLabel,
  applicationStartedLabel,
} from "@/lib/rental-application/in-progress-application";
import { getBundleChoiceLabel, getRoomChoiceLabel } from "@/lib/rental-application/data";
import {
  clusterRowsByResident,
  type ResidentCluster,
} from "@/lib/resident-row-clustering";

export type ManagerApplicationListCluster = ResidentCluster<DemoApplicantRow>;

function applicationListSortBucket(tab: ApplicationListTabId): ApplicationListSortBucket {
  return tab === "approved" ? "approved" : "pending";
}

/** Parse a stable sort key from submitted/started detail or application metadata. */
export function applicationRowSortMs(row: DemoApplicantRow): number {
  const submittedAt = (row.application as { submittedAt?: string } | undefined)?.submittedAt?.trim();
  if (submittedAt) {
    const ms = Date.parse(submittedAt);
    if (Number.isFinite(ms)) return ms;
  }
  const label = applicationStartedLabel(row);
  if (label) {
    const parsed = Date.parse(label.replace(/^(started|submitted|updated)\s+/i, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

export function applicationSubmittedLabel(row: DemoApplicantRow): string {
  return applicationStartedLabel(row) || applicationStageDisplayLabel(row) || row.stage?.trim() || "—";
}

export function applicationPropertyMeta(row: DemoApplicantRow): string {
  const property = stripPropertyRoomCountSuffix(row.property || "").trim();
  const room = applicationRoomLabel(row);
  return [property, room].filter((part) => part && part !== "—").join(" · ") || "—";
}

function applicationRoomLabel(row: DemoApplicantRow): string {
  const raw = row.assignedRoomChoice?.trim() || row.application?.roomChoice1?.trim() || "";
  if (!raw) {
    const bundleId = row.application?.bundleId?.trim() || "";
    const propertyId = row.application?.propertyId?.trim() || row.propertyId?.trim() || "";
    const bundle = bundleId && propertyId ? getBundleChoiceLabel(propertyId, bundleId) : "";
    return bundle.split(" · ")[0]?.trim() || "—";
  }
  const full = getRoomChoiceLabel(raw);
  return full.split(" · ")[0]?.trim() || full || "—";
}

/** Group applications by resident identity — same rule as Tours and Payments. */
export function clusterApplicationListRows(
  rows: readonly DemoApplicantRow[],
): ManagerApplicationListCluster[] {
  return clusterRowsByResident(
    rows.map((row) => ({
      ...row,
      residentName: applicantDisplayName(row),
      residentEmail: row.email?.trim() || row.application?.email?.trim() || "",
    })),
    (row) => stripPropertyRoomCountSuffix(row.property || "") || null,
  );
}

/** Oldest waiting first on actionable tabs; newest first on rejected; property order on approved. */
export function sortApplicationRowsForBucket(
  rows: DemoApplicantRow[],
  tab: ApplicationListTabId,
): DemoApplicantRow[] {
  const copy = [...rows];
  if (tab === "approved") {
    copy.sort((a, b) => compareApplicationRowsForBucket(a, b, applicationListSortBucket(tab)));
    return copy;
  }
  if (tab === "rejected") {
    copy.sort((a, b) => applicationRowSortMs(b) - applicationRowSortMs(a));
    return copy;
  }
  copy.sort((a, b) => applicationRowSortMs(a) - applicationRowSortMs(b));
  return copy;
}

export function sortApplicationClustersForBucket(
  clusters: ManagerApplicationListCluster[],
  tab: ApplicationListTabId,
): ManagerApplicationListCluster[] {
  const clusterSortKey = (cluster: ManagerApplicationListCluster) => {
    if (!cluster.rows.length) return tab === "rejected" ? -Infinity : Infinity;
    const times = cluster.rows.map((row) => applicationRowSortMs(row));
    if (tab === "approved") {
      const lead = sortApplicationRowsForBucket(cluster.rows, tab)[0]!;
      return compareApplicationRowsForBucket(lead, lead, "approved");
    }
    if (tab === "rejected") return Math.max(...times);
    return Math.min(...times);
  };
  const clusterStart = new Map(clusters.map((cluster) => [cluster.key, clusterSortKey(cluster)]));
  const sorted = clusters.map((cluster) => ({
    ...cluster,
    rows: sortApplicationRowsForBucket(cluster.rows, tab),
  }));
  if (tab === "approved") {
    sorted.sort((a, b) => {
      const leadA = a.rows[0];
      const leadB = b.rows[0];
      if (!leadA || !leadB) return 0;
      return compareApplicationRowsForBucket(leadA, leadB, "approved");
    });
    return sorted;
  }
  if (tab === "rejected") {
    sorted.sort((a, b) => (clusterStart.get(b.key) ?? -Infinity) - (clusterStart.get(a.key) ?? -Infinity));
    return sorted;
  }
  sorted.sort((a, b) => (clusterStart.get(a.key) ?? Infinity) - (clusterStart.get(b.key) ?? Infinity));
  return sorted;
}
