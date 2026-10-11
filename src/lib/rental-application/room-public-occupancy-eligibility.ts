import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import {
  leaseIsFullyExecuted,
  normalizeLeasePipelineRow,
  readLeasePipeline,
  type LeasePipelineRow,
} from "@/lib/lease-pipeline-storage";

/** Application row fields needed to decide whether it holds a bed on the public listing. */
export type PublicOccupancyApplicationRow = {
  id: string;
  manuallyAdded?: boolean;
};

/**
 * A manager-added resident (existing or new) holds the room without waiting for
 * e-sign — that is the whole point of `manuallyAdded`.
 */
export function applicationIsManualRoomHold(row: PublicOccupancyApplicationRow): boolean {
  return row.manuallyAdded === true;
}

/** Application ids whose lease is fully executed for one manager portfolio. */
export function executedApplicationIdsForManager(managerUserId?: string | null): Set<string> {
  const ids = new Set<string>();
  for (const lease of readLeasePipeline(managerUserId)) {
    collectExecutedApplicationIdsFromLease(lease, ids);
  }
  return ids;
}

export function collectExecutedApplicationIdsFromLease(
  lease: Pick<LeasePipelineRow, "axisId" | "jointLeaseMembers" | "fullySignedAt" | "status" | "voidedAt" | "externallySignedLease" | "managerSignature" | "residentSignature" | "signatureName" | "signedAtIso">,
  ids: Set<string>,
): void {
  if (!leaseIsFullyExecuted(lease as LeasePipelineRow)) return;
  const axisId = lease.axisId?.trim();
  if (axisId) ids.add(normalizeApplicationAxisId(axisId));
  for (const member of lease.jointLeaseMembers ?? []) {
    const memberId = member.applicationId?.trim();
    if (memberId) ids.add(normalizeApplicationAxisId(memberId));
  }
}

/*
 * There is no "does this approved application hold a room publicly" predicate any more: every
 * approved, non-withdrawn application holds its bed whether or not the lease is signed (a
 * manager-added resident, an approved applicant awaiting e-sign, a fully executed lease), the same
 * rule the manager snapshot (`applicationHoldEntries`) and the database capacity guard apply.
 * Pending applications are the only ones that reserve nothing, and they are never read.
 */

/** Parse lease pipeline DB rows into executed application ids (public occupancy API). */
export function executedApplicationIdsFromLeaseRecords(
  records: readonly { row_data?: unknown }[],
): Set<string> {
  const ids = new Set<string>();
  for (const record of records) {
    if (!record.row_data || typeof record.row_data !== "object") continue;
    collectExecutedApplicationIdsFromLease(normalizeLeasePipelineRow(record.row_data as LeasePipelineRow), ids);
  }
  return ids;
}
