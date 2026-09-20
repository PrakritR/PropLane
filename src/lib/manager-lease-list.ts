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

/**
 * The room / unit text of a lease with the property stripped off — "Room 8"
 * from "5259 Brooklyn Ave NE · 9 rooms · Room 8". Empty when the unit says
 * nothing beyond the property itself.
 */
function leaseRoomText(row: LeasePipelineRow, propertyLabel?: string | null): string {
  const unit = row.unit?.trim() || "";
  if (!unit) return "";

  let compact = formatCompactPlacementLine(unit);
  const property = propertyLabel?.trim() ? stripPropertyRoomCountSuffix(propertyLabel.trim()) : "";
  if (property) {
    const prefix = `${property} · `;
    if (compact.toLowerCase().startsWith(prefix.toLowerCase())) {
      compact = compact.slice(prefix.length).trim();
    } else if (compact.toLowerCase() === property.toLowerCase()) {
      compact = "";
    }
  }

  compact = dedupePlacementSegments(compact);
  return compact && compact !== "—" ? compact : "";
}

/** Primary line for a lease inside a resident cluster — room/unit when known, else status. */
export function leaseGroupedRowPrimary(
  row: LeasePipelineRow,
  clusterPropertyLabel?: string | null,
): string {
  const stage = row.stageLabel?.trim() || row.status?.trim() || "Lease";
  if (!row.unit?.trim()) return stage;
  return leaseRoomText(row, clusterPropertyLabel) || stage;
}

/**
 * The place line of a lease card — "5259 Brooklyn Ave · Room 4": the property,
 * then the room when the unit names one. A room-count segment ("9 rooms") is
 * not a room and never rides along; a unit that only repeats the property
 * prints the property once.
 */
export function leaseRowPlaceLine(row: LeasePipelineRow): string {
  const property = stripPropertyRoomCountSuffix(leasePropertyLabel(row));
  const room = leaseRoomText(row, property)
    .split(" · ")
    .map((part) => part.trim())
    .filter((part) => part && !/^\d+\s*rooms?$/i.test(part) && part.toLowerCase() !== property.toLowerCase())
    .join(" · ");
  const line = [property, room].filter(Boolean).join(" · ");
  return line || row.unit?.trim() || "—";
}

/**
 * The stage as a plain fact — "Draft", "Manager Review", "Fully Signed" — for
 * the card's facts line. A bucket holds several stages (Draft and Manager
 * review both sit under "Manager review"), which is the only reason the row
 * says it at all; it is text beside a glyph, never a pill.
 */
export function leaseStageFact(row: LeasePipelineRow): string | undefined {
  return row.stageLabel?.trim() || row.status?.trim() || undefined;
}

/** " · Renewal requested" / " · Signed off-platform" — what the update stamp carries after the date. */
function leaseUpdatedSuffix(row: LeasePipelineRow): string {
  if (row.pendingRenewal && row.status === "Manager Review") return " · Renewal requested";
  // An executed filing (paper or another tool) is signed, but not by PropLane's
  // e-sign — say so where the manager scans the list.
  if (row.externallySignedLease === true && row.fullySignedAt && row.status === "Fully Signed") {
    return " · Signed off-platform";
  }
  return "";
}

export function leaseUpdatedLabel(row: LeasePipelineRow): string {
  return `${row.updated?.trim() || "—"}${leaseUpdatedSuffix(row)}`;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/;

/**
 * "Updated Sep 18" — the last-update fact on a lease card. The ISO stamp is
 * formatted as short month + day (the year only when it is not this one); a
 * row with no parseable stamp falls back to its `updated` text. Never an ISO
 * string: the raw timestamp is what the old nested row printed.
 */
export function leaseUpdatedShort(row: LeasePipelineRow, now = new Date()): string {
  const iso = row.updatedAtIso?.trim() || "";
  const fallback = row.updated?.trim() || "";
  const ms = Date.parse(iso) || (ISO_DATE_RE.test(fallback) ? Date.parse(fallback) : NaN);
  let when: string;
  if (Number.isFinite(ms) && ms > 0) {
    const d = new Date(ms);
    const sameYear = d.getFullYear() === now.getFullYear();
    when = d.toLocaleDateString(
      "en-US",
      sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" },
    );
  } else {
    when = fallback && !ISO_DATE_RE.test(fallback) ? fallback : "";
  }
  return `Updated ${when || "—"}${leaseUpdatedSuffix(row)}`;
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
