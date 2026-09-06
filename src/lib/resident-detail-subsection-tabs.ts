import type { ManagerLeaseTab } from "@/data/demo-portal";
import {
  MANAGER_TOUR_BUCKET_LABELS,
  MANAGER_TOUR_BUCKETS,
  type ManagerTourBucketId,
  type ResidentApplicationBucketId,
} from "@/lib/portal-detail-routes";

/** Resident detail Application tab — matches Applications hub buckets (no incomplete). */
export const RESIDENT_DETAIL_APPLICATION_BUCKET_TABS: {
  id: ResidentApplicationBucketId;
  label: string;
  dataAttr: string;
}[] = [
  { id: "pending", label: "Pending", dataAttr: "resident-application-bucket-pending" },
  { id: "approved", label: "Approved", dataAttr: "resident-application-bucket-approved" },
  { id: "rejected", label: "Rejected", dataAttr: "resident-application-bucket-rejected" },
];

/** Resident detail Lease tab — same pipeline stages as the Leases hub. */
export const RESIDENT_DETAIL_LEASE_PIPELINE_TABS: {
  id: ManagerLeaseTab;
  label: string;
  shortLabel: string;
  dataAttr: string;
}[] = [
  { id: "manager", label: "Manager review", shortLabel: "Manager", dataAttr: "resident-lease-tab-manager" },
  { id: "resident", label: "Resident signature", shortLabel: "Resident", dataAttr: "resident-lease-tab-resident" },
  { id: "signed", label: "Manager signature", shortLabel: "Mgr sign", dataAttr: "resident-lease-tab-signed" },
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
