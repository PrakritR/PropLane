import type { DemoApplicantRow } from "@/data/demo-portal";
import { applicationShowsBackgroundCheck, resolveBackgroundCheckStatus } from "@/lib/application-background-check";
import type { LeaseListTabId } from "@/lib/lease-pipeline-storage";
import {
  MANAGER_TOUR_BUCKET_LABELS,
  MANAGER_TOUR_BUCKETS,
  type ManagerTourBucketId,
} from "@/lib/portal-detail-routes";
import { isInProgressApplicationRow } from "@/lib/rental-application/in-progress-application";

/**
 * The one status vocabulary of the resident record's Application and Background check tabs:
 * Incomplete · Pending · Approved · Rejected.
 */
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

/** Resident detail Background check tab — the same four buckets, mapped from the check's status. */
export const RESIDENT_DETAIL_BACKGROUND_CHECK_BUCKET_TABS: {
  id: ResidentRecordStatusBucketId;
  label: string;
  dataAttr: string;
}[] = RESIDENT_DETAIL_APPLICATION_BUCKET_TABS.map((tab) => ({
  ...tab,
  dataAttr: tab.dataAttr.replace("resident-application-bucket-", "resident-background-check-bucket-"),
}));

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

/**
 * Which Background check tab a resident's check sits under (a person has one check, so it lands in
 * exactly one bucket):
 *  - not run (nothing ordered, or no check for this resident)  → Incomplete
 *  - ordered / in progress                                       → Pending
 *  - complete and clear                                          → Approved
 *  - complete with anything to review (consider / failed)        → Rejected
 */
export function residentBackgroundCheckStatusBucket(row: DemoApplicantRow): ResidentRecordStatusBucketId {
  if (!applicationShowsBackgroundCheck(row)) return "incomplete";
  const check = row.backgroundCheck;
  const screening = row.screening;
  if (check) {
    if (check.status === "complete") return check.result === "clear" ? "approved" : "rejected";
    return "pending";
  }
  if (screening) {
    if (screening.status === "complete") return screening.recommendation === "strong_yes" ? "approved" : "rejected";
    return "pending";
  }
  const status = resolveBackgroundCheckStatus(row);
  if (status === "passed") return "approved";
  if (status === "flagged") return "rejected";
  return "incomplete";
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
