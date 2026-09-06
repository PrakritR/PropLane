import type { DemoApplicantRow } from "@/data/demo-portal";
import { isDraftApplicationRow } from "@/lib/manager-applications-storage";
import { isInProgressApplicationRow } from "@/lib/rental-application/in-progress-application";

/** Pending (submitted) or active approved residents that should keep generated payment schedules. */
export function shouldReconcileResidentPaymentSchedule(row: DemoApplicantRow, nowMs = Date.now()): boolean {
  if (row.migrationBillingHold) return false;
  if (!row.email?.trim()) return false;
  if (row.bucket === "pending") return !isDraftApplicationRow(row);
  return isCurrentResidentApplicationRow(row, nowMs);
}

export const PREVIOUS_RESIDENT_STAGE_TOKENS = ["moved out", "previous", "past", "former", "inactive"] as const;

export function hasMoveOutDatePassed(moveOutDate: string | undefined, nowMs = Date.now()): boolean {
  const moveOut = moveOutDate?.trim();
  if (!moveOut) return false;
  const parsed = new Date(`${moveOut}T23:59:59`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.getTime() < nowMs;
}

export function isPreviousResidentStage(stage: string | undefined): boolean {
  const normalized = stage?.trim().toLowerCase() ?? "";
  return PREVIOUS_RESIDENT_STAGE_TOKENS.some((token) => normalized.includes(token));
}

export function isCurrentResidentApplicationRow(row: DemoApplicantRow, nowMs = Date.now()): boolean {
  if (row.bucket !== "approved") return false;
  if (hasMoveOutDatePassed(row.manualResidentDetails?.moveOutDate, nowMs)) return false;
  return !isPreviousResidentStage(row.stage);
}

/** Pending (submitted) or approved applications shown on the manager Residents tab. */
export function isResidentDirectoryRow(row: DemoApplicantRow): boolean {
  if (isInProgressApplicationRow(row)) return false;
  return row.bucket === "approved" || row.bucket === "pending";
}

/** Whether a Residents-tab row belongs under Previous (moved-out approved only). */
export function isPreviousResidentDirectoryRow(row: DemoApplicantRow, nowMs = Date.now()): boolean {
  if (row.bucket === "pending") return false;
  return !isCurrentResidentApplicationRow(row, nowMs);
}
