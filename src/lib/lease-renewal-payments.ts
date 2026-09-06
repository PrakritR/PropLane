/**
 * Applies a signed lease renewal to the payment system. The renew flow stashes
 * the new terms on the lease row (`pendingRenewal`, see lease-amendment.server)
 * without touching the application record or charges — payments must follow
 * the SIGNED lease, never a draft. Once both parties have signed, this writes
 * the new term/dates/rent onto the application record (charges derive from the
 * application, not the lease row) and reprices the schedule:
 * pending rent charges are rewritten to the new amount and the recurring rent
 * profile + one-time charges are refreshed for the new period.
 *
 * Runs in the manager's browser (the charge helpers are client-side, and the
 * manager countersigns last in the pipeline), mirroring the manual
 * edit-resident reprice in manager-residents.tsx.
 */
import {
  readManagerApplicationRows,
  normalizeApplicationAxisId,
  writeManagerApplicationRows,
} from "@/lib/manager-applications-storage";
import {
  recordApprovedApplicationCharges,
  updatePendingRentAmountForResident,
} from "@/lib/household-charges";
import {
  hasBothLeaseSignatures,
  readLeasePipeline,
  updateLeasePipelineRow,
  type LeasePipelineRow,
} from "@/lib/lease-pipeline-storage";
import { renewalRentalTypeForTerm } from "@/lib/lease-renewal-terms";

export async function applySignedLeaseRenewal(leaseRowId: string, managerUserId: string | null): Promise<boolean> {
  const leaseRow = readLeasePipeline(managerUserId ?? undefined).find((r) => r.id === leaseRowId);
  const renewal = leaseRow?.pendingRenewal;
  if (!leaseRow || !renewal) return false;
  if (!hasBothLeaseSignatures(leaseRow)) return false;

  const residentEmail = leaseRow.residentEmail.trim().toLowerCase();
  const rows = readManagerApplicationRows();
  const matches = rows.map((row, index) => ({ row, index })).filter(({ row }) => leaseRow.axisId
    ? normalizeApplicationAxisId(row.id) === normalizeApplicationAxisId(leaseRow.axisId)
    : (row.email ?? "").trim().toLowerCase() === residentEmail);
  const idx = matches.length === 1 ? matches[0].index : -1;

  if (idx >= 0) {
    const existing = rows[idx]!;
    const rentalType = renewal.rentalType ?? renewalRentalTypeForTerm(renewal.leaseTerm);
    const isShortTerm = rentalType === "short_term";
    const nextRow = {
      ...existing,
      ...(renewal.monthlyRent != null ? { signedMonthlyRent: renewal.monthlyRent } : {}),
      manualResidentDetails: {
        ...(existing.manualResidentDetails ?? {}),
        moveInDate: renewal.leaseStart || undefined,
        moveOutDate: renewal.leaseEnd || undefined,
        leaseTerm: renewal.leaseTerm || undefined,
      },
      application: existing.application
        ? {
            ...existing.application,
            rentalType,
            leaseTerm: renewal.leaseTerm,
            leaseStart: renewal.leaseStart,
            leaseEnd: renewal.leaseEnd,
            ...(renewal.monthlyRent != null ? { managerRentOverride: String(renewal.monthlyRent) } : {}),
          }
        : existing.application,
    };
    const next = [...rows];
    next[idx] = nextRow;
    try {
      const response = await fetch("/api/manager-applications", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "upsert", row: nextRow }) });
      if (!response.ok || (await response.json()).ok !== true) return false;
    } catch { return false; }
    writeManagerApplicationRows(next, { serverConfirmed: true });

    const propertyId = nextRow.assignedPropertyId ?? nextRow.application?.propertyId ?? leaseRow.propertyId ?? "";
    if (
      !isShortTerm &&
      propertyId &&
      renewal.monthlyRent != null &&
      Number.isFinite(renewal.monthlyRent)
    ) {
      updatePendingRentAmountForResident(residentEmail, propertyId, renewal.monthlyRent, managerUserId);
    }
    // force=true wipes and regenerates the pending schedule (deposit/move-in
    // fee stay settled; rent months re-derive from the new profile + dates).
    recordApprovedApplicationCharges(nextRow, managerUserId, true);
  }

  if (idx < 0) return false;
  updateLeasePipelineRow(leaseRowId, { pendingRenewal: null }, managerUserId);
  return idx >= 0;
}

export function leaseRowHasPendingRenewal(row: LeasePipelineRow | null | undefined): boolean {
  return Boolean(row?.pendingRenewal);
}
