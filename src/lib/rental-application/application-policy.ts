import type { DemoApplicantRow } from "@/data/demo-portal";
import type { ApplicationFeeChargePolicy } from "@/lib/manager-application-settings";
import {
  readChargesForResident,
  findApplicationFeeCharge,
  listingApplicationFeeAmount,
} from "@/lib/household-charges";
import { readManagerApplicationRows } from "@/lib/manager-applications-storage";
import { getPropertyById } from "@/lib/rental-application/data";
import { isInProgressApplicationRow } from "@/lib/rental-application/in-progress-application";

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function applicationsForResidentEmail(email: string): DemoApplicantRow[] {
  const e = normalizeEmail(email);
  if (!e) return [];
  return readManagerApplicationRows().filter((row) => normalizeEmail(row.email ?? "") === e);
}

/**
 * Resident already has a submitted application before this new one. When
 * `managerUserId` is provided, only applications attributed to that manager
 * count.
 */
export function residentHasPriorApplication(email: string, managerUserId?: string | null): boolean {
  return applicationsForResidentEmail(email).some(
    (row) =>
      !isInProgressApplicationRow(row) &&
      (managerUserId == null || row.managerUserId === managerUserId),
  );
}

/**
 * Resident has a paid application-fee charge. When `managerUserId` is provided,
 * only charges billed by that manager count.
 */
export function residentHasPaidApplicationFee(
  email: string,
  residentUserId?: string | null,
  managerUserId?: string | null,
): boolean {
  const e = normalizeEmail(email);
  if (!e) return false;
  return readChargesForResident(e, residentUserId ?? null).some(
    (c) =>
      c.kind === "application_fee" &&
      c.status === "paid" &&
      (managerUserId == null || c.managerUserId === managerUserId),
  );
}

/**
 * The application fee is collected per the manager's charge policy
 * (`first_only` vs `every_time`). Under `first_only`, a resident who already
 * submitted to — or already paid an application fee billed by — this property's
 * manager is waived on any of that manager's listings. Under `every_time`, each
 * application owes the fee unless a waiver code or an existing paid charge for
 * THIS application applies. History with a DIFFERENT manager never waives
 * another manager's fee.
 */
export function shouldWaiveApplicationFeeForResident(input: {
  propertyId: string;
  residentEmail: string;
  residentUserId?: string | null;
  chargePolicy?: ApplicationFeeChargePolicy;
}): boolean {
  const pid = input.propertyId.trim();
  const email = normalizeEmail(input.residentEmail);
  if (!pid || !email) return false;
  const managerUserId = getPropertyById(pid)?.managerUserId?.trim() || null;
  if (!managerUserId) return false;
  if (input.chargePolicy === "every_time") return false;
  return (
    residentHasPriorApplication(email, managerUserId) ||
    residentHasPaidApplicationFee(email, input.residentUserId, managerUserId)
  );
}

export function residentApplicationFeeGate(input: {
  propertyId: string;
  residentEmail: string;
  residentUserId?: string | null;
  chargePolicy?: ApplicationFeeChargePolicy;
  /** When the server preview has already decided waiver, trust it over local rows. */
  serverFeeWaived?: boolean | null;
  /**
   * SERVER-authoritative fee in cents from `/api/public/application-fee-preview`
   * (which applies the manager-level fee). When provided it overrides the
   * browser catalog's per-listing amount entirely — including an explicit 0
   * ("applications are free"), which passes the applicant through with no
   * payment step. Omit only where no server is reachable (demo sandbox).
   */
  serverFeeCents?: number | null;
}): { needsFee: boolean; paid: boolean; displayLabel: string; amount: number; waived: boolean } {
  const pid = input.propertyId.trim();
  const email = input.residentEmail.trim();
  const listingFee = listingApplicationFeeAmount(pid);
  const amount = input.serverFeeCents != null ? input.serverFeeCents / 100 : listingFee.amount;
  const displayLabel =
    input.serverFeeCents != null
      ? amount > 0
        ? `$${amount.toFixed(2)}`
        : "—"
      : listingFee.displayLabel;
  const waived =
    input.serverFeeWaived === true ||
    (input.serverFeeWaived !== false &&
      shouldWaiveApplicationFeeForResident({
        propertyId: pid,
        residentEmail: email,
        residentUserId: input.residentUserId,
        chargePolicy: input.chargePolicy,
      }));
  if (!pid || !email.includes("@") || amount <= 0 || waived) {
    return { needsFee: false, paid: true, displayLabel, amount, waived };
  }
  const charge = findApplicationFeeCharge(email, pid, input.residentUserId ?? null);
  const paid = charge?.status === "paid";
  return { needsFee: true, paid, displayLabel, amount, waived: false };
}

export function residentApplicationSubmitBlocked(input: {
  propertyId: string;
  residentEmail: string;
  roomChoice1?: string;
}): { blocked: boolean; reason?: string } {
  const pid = input.propertyId.trim();
  const email = normalizeEmail(input.residentEmail);
  if (!pid || !email) return { blocked: false };

  // Applying to multiple properties/rooms is always allowed — a resident may
  // hold several applications at once (one per property + room). The only thing
  // blocked is a genuine duplicate: a second PENDING application for the exact
  // same property AND room. (This used to be gated on a per-listing
  // `allowMultiplePropertyApplications` toggle, removed with per-property
  // applications; a returning applicant after a final withdrawal starts fresh.)
  const existing = applicationsForResidentEmail(email).filter((row) => !isInProgressApplicationRow(row));
  const room = input.roomChoice1?.trim() || "";

  const duplicatePending = existing.some((row) => {
    if (row.bucket !== "pending" || isInProgressApplicationRow(row)) return false;
    const rowPid = row.propertyId?.trim() || row.application?.propertyId?.trim() || "";
    if (rowPid !== pid) return false;
    const rowRoom = row.application?.roomChoice1?.trim() || row.assignedRoomChoice?.trim() || "";
    return rowRoom === room;
  });
  if (duplicatePending) {
    return {
      blocked: true,
      reason: "You already have a pending application for this property and room.",
    };
  }

  return { blocked: false };
}

/** Residents may withdraw only applications still awaiting manager review. */
export function residentCanWithdrawApplication(row: DemoApplicantRow): boolean {
  return row.bucket === "pending";
}
