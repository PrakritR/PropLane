import type { ManagerLeaseTab } from "@/data/demo-portal";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import {
  dedupePlacementSegments,
  formatCompactPlacementLine,
  stripPropertyRoomCountSuffix,
} from "@/lib/portal-mobile-preview";
import { getPropertyById } from "@/lib/rental-application/data";
import {
  clusterRowsByResident,
  type ResidentCluster,
} from "@/lib/resident-row-clustering";

export type ManagerLeaseListCluster = ResidentCluster<LeasePipelineRow>;

export function leaseRowSortMs(row: LeasePipelineRow): number {
  const ms = Date.parse(row.updatedAtIso || "");
  return Number.isFinite(ms) ? ms : 0;
}

export function leasePropertyLabel(row: LeasePipelineRow): string {
  const propertyId = row.propertyId?.trim() ?? "";
  const fromCatalog = propertyId ? getPropertyById(propertyId)?.title?.trim() : "";
  if (fromCatalog) return fromCatalog;
  const unit = row.unit?.trim() ?? "";
  return unit.split(" · ")[0]?.trim() || unit || "";
}

export function leaseUnitMeta(row: LeasePipelineRow): string {
  return row.unit?.trim() || "—";
}

/** Primary line for a lease inside a resident cluster — room/unit when known, else status. */
export function leaseGroupedRowPrimary(
  row: LeasePipelineRow,
  clusterPropertyLabel?: string | null,
): string {
  const unit = row.unit?.trim() || "";
  if (!unit) return row.stageLabel?.trim() || row.status?.trim() || "Lease";

  let compact = formatCompactPlacementLine(unit);
  const clusterProperty = clusterPropertyLabel?.trim()
    ? stripPropertyRoomCountSuffix(clusterPropertyLabel.trim())
    : "";
  if (clusterProperty) {
    const prefix = `${clusterProperty} · `;
    if (compact.toLowerCase().startsWith(prefix.toLowerCase())) {
      compact = compact.slice(prefix.length).trim();
    } else if (compact.toLowerCase() === clusterProperty.toLowerCase()) {
      compact = "";
    }
  }

  compact = dedupePlacementSegments(compact);
  if (compact && compact !== "—") return compact;
  return row.stageLabel?.trim() || row.status?.trim() || "Lease";
}

/** Secondary line — last update (status renders as the row pill). */
export function leaseGroupedRowMeta(row: LeasePipelineRow): string {
  return leaseUpdatedLabel(row);
}

export function leaseStatusPill(
  row: LeasePipelineRow,
): { label: string; tone: "info" | "warning" | "muted" | "success" } | undefined {
  const label = row.stageLabel?.trim() || row.status?.trim();
  if (!label) return undefined;
  const normalized = label.toLowerCase();
  if (normalized.includes("signed") || normalized.includes("completed")) {
    return { label, tone: "success" };
  }
  if (normalized.includes("review") || normalized.includes("draft")) {
    return { label, tone: "warning" };
  }
  if (normalized.includes("void")) return { label, tone: "muted" };
  return { label, tone: "info" };
}

export function leaseUpdatedLabel(row: LeasePipelineRow): string {
  if (row.pendingRenewal && row.status === "Manager Review") {
    return `${row.updated} · Renewal requested`;
  }
  // An executed filing (paper or another tool) is signed, but not by PropLane's
  // e-sign — say so where the manager scans the list.
  if (row.externallySignedLease === true && row.fullySignedAt && row.status === "Fully Signed") {
    return `${row.updated?.trim() || "—"} · Signed off-platform`;
  }
  return row.updated?.trim() || "—";
}

/** Group leases by resident identity — same rule as Tours and Applications. */
export function clusterManagerLeaseListRows(
  rows: readonly LeasePipelineRow[],
): ManagerLeaseListCluster[] {
  return clusterRowsByResident(rows, (row) => leasePropertyLabel(row) || null);
}

/** Active pipeline tabs: oldest update first; signed tab: newest first. */
export function sortManagerLeaseRowsForBucket(
  rows: LeasePipelineRow[],
  tab: ManagerLeaseTab,
): LeasePipelineRow[] {
  const copy = [...rows];
  if (tab === "completed") {
    copy.sort((a, b) => leaseRowSortMs(b) - leaseRowSortMs(a));
  } else {
    copy.sort((a, b) => leaseRowSortMs(a) - leaseRowSortMs(b));
  }
  return copy;
}

export function sortManagerLeaseClustersForBucket(
  clusters: ManagerLeaseListCluster[],
  tab: ManagerLeaseTab,
): ManagerLeaseListCluster[] {
  const clusterSortKey = (cluster: ManagerLeaseListCluster) => {
    if (!cluster.rows.length) return tab === "completed" ? -Infinity : Infinity;
    const times = cluster.rows.map((row) => leaseRowSortMs(row));
    return tab === "completed" ? Math.max(...times) : Math.min(...times);
  };
  const clusterStart = new Map(clusters.map((cluster) => [cluster.key, clusterSortKey(cluster)]));
  const sorted = clusters.map((cluster) => ({
    ...cluster,
    rows: sortManagerLeaseRowsForBucket(cluster.rows, tab),
  }));
  if (tab === "completed") {
    sorted.sort((a, b) => (clusterStart.get(b.key) ?? -Infinity) - (clusterStart.get(a.key) ?? -Infinity));
  } else {
    sorted.sort((a, b) => (clusterStart.get(a.key) ?? Infinity) - (clusterStart.get(b.key) ?? Infinity));
  }
  return sorted;
}
