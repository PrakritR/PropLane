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
  isInProgressApplicationRow,
} from "@/lib/rental-application/in-progress-application";
import { isWithdrawnApplicationRow } from "@/lib/rental-application/resident-application-list";
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

/**
 * The one stage fact an application row may still carry, as plain text in
 * its facts line — or nothing. The tab already says the bucket (Incomplete,
 * Pending, Approved, Rejected), so this only returns what ADDS to it: a
 * withdrawn application, or the approved stage's own suffix — "Existing
 * resident", "Placed". "Active" is what every approved application is and
 * says nothing, so it is silent too.
 */
export function applicationStageFact(
  row: Pick<DemoApplicantRow, "bucket" | "stage" | "detail" | "application" | "withdrawnAt">,
): string | undefined {
  if (isInProgressApplicationRow(row as DemoApplicantRow)) return undefined;
  if (isWithdrawnApplicationRow(row as DemoApplicantRow)) return "Withdrawn";
  if (row.bucket !== "approved") return undefined;
  const stage = (row.stage ?? "").trim();
  const suffix = stage.replace(/^approved\s*[-–·]?\s*/i, "").trim();
  if (!suffix) return undefined;
  const lower = suffix.toLowerCase();
  if (lower === "approved" || lower === "active") return undefined;
  return suffix[0]!.toUpperCase() + suffix.slice(1);
}

/**
 * The date in a row's facts line — "Sep 11", or "Sep 11, 2025" once the year
 * is not this one. Read from the same detail line the list sorts by; a row
 * with no parseable date shows no date fact at all.
 */
export function applicationSubmittedShort(row: Pick<DemoApplicantRow, "detail" | "application" | "bucket" | "stage">, now = new Date()): string {
  // The detail line carries a calendar date ("Submitted 2026-09-11"); read it
  // as that day, not as UTC midnight, or Seattle shows the day before.
  const label = applicationStartedLabel(row).replace(/^(started|submitted|updated)\s+/i, "");
  const iso = label.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const d = iso ? new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])) : (() => { const ms = applicationRowSortMs(row as DemoApplicantRow); return ms > 0 ? new Date(ms) : null; })();
  if (!d) return "";
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString("en-US", sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

/** "Submitted", "Started" or "Updated" — the verb the detail line opens with. */
export function applicationDateVerb(row: Pick<DemoApplicantRow, "detail">): string {
  const m = applicationStartedLabel(row).match(/^(started|submitted|updated)\b/i);
  return m ? m[1]![0]!.toUpperCase() + m[1]!.slice(1).toLowerCase() : "Submitted";
}
