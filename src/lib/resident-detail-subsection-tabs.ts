import type { LeaseListTabId } from "@/lib/lease-pipeline-storage";
import {
  MANAGER_TOUR_BUCKET_LABELS,
  MANAGER_TOUR_BUCKETS,
  type ManagerTourBucketId,
  type ResidentApplicationBucketId,
} from "@/lib/portal-detail-routes";

/** Resident detail Application tab — matches Applications hub buckets (Pending · Approved · Declined). */
export const RESIDENT_DETAIL_APPLICATION_BUCKET_TABS: {
  id: ResidentApplicationBucketId;
  label: string;
  dataAttr: string;
}[] = [
  { id: "pending", label: "Pending", dataAttr: "resident-application-bucket-pending" },
  { id: "approved", label: "Approved", dataAttr: "resident-application-bucket-approved" },
  { id: "rejected", label: "Declined", dataAttr: "resident-application-bucket-rejected" },
];

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
