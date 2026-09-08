import type { DemoApplicantRow } from "@/data/demo-portal";
import { isDraftApplicationRow } from "@/lib/manager-applications-storage";

/**
 * Whose existing charges survive a reconcile pass.
 *
 * Deliberately WIDER than `residentChargeMoment` below, and the two must not be
 * collapsed back into one predicate. A submitted applicant belongs here because
 * a manager can add a real charge to one — an application fee, a holding fee —
 * and the reconciler's wipe filter would otherwise delete it on the next portal
 * load. That is what `6aeb64df` fixed. It is NOT a statement that the applicant
 * should be BILLED a move-in schedule; ask `residentChargeMoment` for that.
 */
export function shouldRetainResidentPaymentSchedule(row: DemoApplicantRow, nowMs = Date.now()): boolean {
  if (row.migrationBillingHold) return false;
  if (!row.email?.trim()) return false;
  if (row.bucket === "pending") return !isDraftApplicationRow(row);
  return isCurrentResidentApplicationRow(row, nowMs);
}

/**
 * Which lifecycle moment a person's charges belong to.
 *
 * Only two moments create money, and approval is not one of them:
 *
 *  - `"application"` — submitted, undecided. The application fee is genuinely
 *    owed here (they met it in the apply flow) and nothing else is.
 *  - `"none"` — approved but the lease is not executed, or the tenancy is over.
 *    An approval is a decision, not a bill: quoting rent, a deposit or utilities
 *    for a lease nobody has signed is inventing money owed.
 *  - `"signed"` — the lease is executed, so the whole schedule is real.
 *
 * `leaseExecuted` is supplied by the caller for the same reason
 * `residentDirectoryStage` takes it: the answer lives in the lease pipeline,
 * not on the application row. `manuallyAdded` is its own sufficient signal — a
 * manager onboarding an existing tenant by hand is asserting the tenancy
 * directly and may never file a lease in PropLane at all.
 */
export type ResidentChargeMoment = "application" | "none" | "signed";

export function residentChargeMoment(
  row: DemoApplicantRow,
  opts: { leaseExecuted: boolean },
  nowMs = Date.now(),
): ResidentChargeMoment {
  if (row.migrationBillingHold) return "none";
  if (!row.email?.trim()) return "none";
  if (isDraftApplicationRow(row)) return "none";
  if (residentTenancyEnded(row, nowMs)) return "none";
  // The SIGNATURE bills, whatever the application bucket says. A lease can be
  // executed while its application row still reads pending — the person signed,
  // so they are a tenant — and that ordering must not decide whether they are
  // billed. What the bucket can never do is bill someone with no lease at all.
  if (opts.leaseExecuted || row.manuallyAdded === true) return "signed";
  if (row.bucket === "pending") return "application";
  return "none";
}

/** A tenancy that is over: the move-out date has passed, or the stage says former. */
export function residentTenancyEnded(row: DemoApplicantRow, nowMs = Date.now()): boolean {
  return (
    hasMoveOutDatePassed(row.manualResidentDetails?.moveOutDate, nowMs) || isPreviousResidentStage(row.stage)
  );
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

/**
 * Applications that appear anywhere in the manager Residents directory.
 *
 * Unfinished ("Incomplete") applications are INCLUDED: they are the earliest
 * stage of the same person, and the manager's move on one — chase them to
 * finish it — only exists if they are on the list. Which of the three
 * directory stages a row lands in is `residentDirectoryStage`'s answer, not
 * this one's.
 */
export function isResidentDirectoryRow(row: DemoApplicantRow): boolean {
  return row.bucket === "approved" || row.bucket === "pending";
}

/** Whether a Residents-tab row belongs under Previous (moved-out approved only). */
export function isPreviousResidentDirectoryRow(row: DemoApplicantRow, nowMs = Date.now()): boolean {
  if (row.bucket === "pending") return false;
  return !isCurrentResidentApplicationRow(row, nowMs);
}

/** The three stages of the manager Residents directory. */
export type ResidentDirectoryStage = "potential" | "current" | "past";

/**
 * Which directory stage a person sits in.
 *
 * The dividing line is the SIGNED LEASE, not the approval. An unfinished
 * application, a submitted one awaiting review, and an approved one whose
 * lease nobody has executed are all the same thing to a manager — somebody who
 * might live here — so they share the Potential stage. Tenancy starts when the
 * lease is executed.
 *
 * `leaseExecuted` is supplied by the caller because the answer lives in the
 * lease pipeline, not on the application row; `manuallyAdded` is its own
 * sufficient signal, because a manager who onboards an existing tenant by hand
 * is asserting the tenancy directly and may never file a lease here at all.
 */
export function residentDirectoryStage(
  row: DemoApplicantRow,
  opts: { leaseExecuted: boolean },
  nowMs = Date.now(),
): ResidentDirectoryStage {
  if (row.bucket !== "approved") return "potential";
  if (!isCurrentResidentApplicationRow(row, nowMs)) return "past";
  return opts.leaseExecuted || row.manuallyAdded === true ? "current" : "potential";
}
