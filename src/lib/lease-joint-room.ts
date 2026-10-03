/**
 * Roommates on one joint shared-room lease.
 *
 * Each roommate keeps their OWN lease row — their own account, signature, rent and charges, so
 * every authorization and signing guard in the lease pipeline applies unchanged — and the rows of
 * one joint lease share `jointRoomGroupId`. This module is the one place that reads that link:
 * which rows travel together, who has not signed yet, and whether the manager can countersign.
 */
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";

/** The other roommates' rows of this lease (not voided), or `[]` for an ordinary lease. */
export function jointRoomSiblings(row: LeasePipelineRow, rows: readonly LeasePipelineRow[]): LeasePipelineRow[] {
  const groupId = row.jointRoomGroupId?.trim();
  if (!groupId) return [];
  return rows.filter((r) => r.id !== row.id && r.jointRoomGroupId?.trim() === groupId && r.status !== "Voided");
}

/** Every row of the joint lease, this one first. */
export function jointRoomRows(row: LeasePipelineRow, rows: readonly LeasePipelineRow[]): LeasePipelineRow[] {
  return [row, ...jointRoomSiblings(row, rows)];
}

function residentHasSigned(row: LeasePipelineRow): boolean {
  return Boolean(row.residentSignature || (row.signatureName && row.signedAtIso));
}

/** True when every roommate on the joint lease has signed (always true for an ordinary lease). */
export function jointRoomAllResidentsSigned(row: LeasePipelineRow, rows: readonly LeasePipelineRow[]): boolean {
  return jointRoomRows(row, rows).every(residentHasSigned);
}

/**
 * The manager signs a joint lease once — and only after EVERY roommate has. Returns why not, or
 * null when countersigning may go ahead (an ordinary lease is unaffected).
 */
export function jointRoomCountersignBlocker(row: LeasePipelineRow, rows: readonly LeasePipelineRow[]): string | null {
  if (!row.jointRoomGroupId?.trim()) return null;
  const waiting = jointRoomRows(row, rows).filter((r) => !residentHasSigned(r));
  if (waiting.length === 0) return null;
  const names = waiting.map((r) => r.residentName.split(/\s+/)[0] || r.residentName).join(", ");
  return `Waiting for ${names} to sign before you can countersign this joint lease.`;
}
