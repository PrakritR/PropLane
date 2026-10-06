import type { DemoApplicantRow } from "@/data/demo-portal";
import { resolveBackgroundCheckStatus } from "@/lib/application-background-check";
import type { LeaseListTabId } from "@/lib/lease-pipeline-storage";
import {
  MANAGER_TOUR_BUCKET_LABELS,
  MANAGER_TOUR_BUCKETS,
  type ManagerTourBucketId,
} from "@/lib/portal-detail-routes";
import { isInProgressApplicationRow } from "@/lib/rental-application/in-progress-application";

/** The one status vocabulary of the resident record's Application tab: Incomplete · Pending · Approved · Rejected. */
export type ResidentRecordStatusBucketId = "incomplete" | "pending" | "approved" | "rejected";

/** Resident detail Application tab — Incomplete · Pending · Approved · Rejected. */
export const RESIDENT_DETAIL_APPLICATION_BUCKET_TABS: {
  id: ResidentRecordStatusBucketId;
  label: string;
  dataAttr: string;
}[] = [
  { id: "incomplete", label: "Incomplete", dataAttr: "resident-application-bucket-incomplete" },
  { id: "pending", label: "Pending", dataAttr: "resident-application-bucket-pending" },
  { id: "approved", label: "Approved", dataAttr: "resident-application-bucket-approved" },
  { id: "rejected", label: "Rejected", dataAttr: "resident-application-bucket-rejected" },
];

/**
 * Resident detail Background check tab — ONE tab, Completed (captain, 2026-10-05 round 2).
 *
 * A person has exactly one check, and the four Application buckets said nothing a manager
 * could act on: the check's own panel already states where it stands.
 */
export const RESIDENT_DETAIL_BACKGROUND_CHECK_TABS: {
  id: "completed";
  label: string;
  dataAttr: string;
}[] = [{ id: "completed", label: "Completed", dataAttr: "resident-background-check-tab-completed" }];

/**
 * How many checks the Completed tab counts: a check that has actually come back, never one that
 * merely applies. `applicationShowsBackgroundCheck` answers the second question (anything but
 * `not_applicable`), so counting with it read "Completed 1" for every submitted application while
 * the panel underneath said pending.
 *
 * The REPORT decides, not the derived badge. `backgroundCheckStatusFromScreening` collapses a
 * complete report whose recommendation is `review` or `not_available` back to `pending_review` —
 * and `review` is the default recommendation — so reading only `backgroundCheckStatus` said
 * "Completed 0" beside a panel rendering the finished report. A finished order is counted whatever
 * it concluded; `passed` / `flagged` still covers a result a manager recorded by hand.
 */
export function residentBackgroundCheckCompletedCount(row: DemoApplicantRow | null): number {
  if (!row) return 0;
  if (row.backgroundCheck?.status === "complete") return 1;
  if (row.screening?.status === "complete") return 1;
  const status = resolveBackgroundCheckStatus(row);
  return status === "passed" || status === "flagged" ? 1 : 0;
}

/**
 * Which Application tab an application sits under. Incomplete is an application that was started
 * (or sent) and never submitted — the stored "In progress" draft (`isInProgressApplicationRow`),
 * which still has `bucket: "pending"`. Everything else follows the stored decision bucket.
 */
export function residentApplicationStatusBucket(row: DemoApplicantRow): ResidentRecordStatusBucketId {
  if (isInProgressApplicationRow(row)) return "incomplete";
  if (row.bucket === "approved") return "approved";
  if (row.bucket === "rejected") return "rejected";
  return "pending";
}


/** Resident detail Lease tab — same three stages as the Leases hub: Draft · Sent · Signed. */
export const RESIDENT_DETAIL_LEASE_PIPELINE_TABS: {
  id: LeaseListTabId;
  label: string;
  shortLabel: string;
  dataAttr: string;
}[] = [
  { id: "manager", label: "Draft", shortLabel: "Draft", dataAttr: "resident-lease-tab-manager" },
  { id: "resident", label: "Sent", shortLabel: "Sent", dataAttr: "resident-lease-tab-resident" },
  { id: "completed", label: "Signed", shortLabel: "Signed", dataAttr: "resident-lease-tab-completed" },
];

/** Resident detail Tours tab — same buckets as the portfolio Tours hub. */
export const RESIDENT_DETAIL_TOUR_BUCKET_TABS: {
  id: ManagerTourBucketId;
  label: string;
  dataAttr: string;
}[] = MANAGER_TOUR_BUCKETS.map((id) => ({
  id,
  label: MANAGER_TOUR_BUCKET_LABELS[id],
  dataAttr: `resident-tour-bucket-${id}`,
}));
