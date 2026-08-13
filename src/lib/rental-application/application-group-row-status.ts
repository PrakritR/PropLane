import type { DemoApplicantRow } from "@/data/demo-portal";
import type { ApplicationGroupMemberStatus } from "@/lib/rental-application/application-groups";
import { isInProgressApplicationRow } from "@/lib/rental-application/in-progress-application";

/** Status for group reconciliation — derived from bucket + screening signals only. */
export function applicationStatusForRow(row: DemoApplicantRow): ApplicationGroupMemberStatus {
  if (row.bucket === "approved") return "approved";
  if (row.bucket === "rejected") return "rejected";
  if (isInProgressApplicationRow(row)) return "in_progress";
  const bg = row.backgroundCheckStatus;
  if (bg === "flagged") return "flagged";
  if (bg === "passed") return "screened";
  if (bg === "pending_review" || row.screening) return "screening";
  return "submitted";
}
