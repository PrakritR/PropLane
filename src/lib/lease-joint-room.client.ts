/**
 * Link the roommates of a joint shared-room lease.
 *
 * A room whose `sharedRoomLeaseKind` is `"joint"` is let to its roommates on ONE lease: one send,
 * one countersignature, each roommate signing in their own account (`lease-joint-room.ts` reads the
 * link). This is the one place the link is made — every roommate's Draft lease (created when they were
 * approved) gets the shared `jointRoomGroupId`, and they travel together from then on. Roommates are
 * the approved, not-withdrawn applications sharing the resident's Group ID and room, so a group
 * member who has not been approved yet is simply not on the lease (a group never blocks).
 */
import type { DemoApplicantRow } from "@/data/demo-portal";
import { roomForApplicationRow } from "@/lib/application-approval-slots";
import {
  ensureManagerReviewLeaseForApplication,
  updateLeasePipelineRow,
  type LeasePipelineRow,
} from "@/lib/lease-pipeline-storage";
import { sharedRoomIsOnJointLease } from "@/lib/leasing-pipeline-client-cache";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import { parseRoomChoiceValue } from "@/lib/rental-application/data";

function roomKey(app: DemoApplicantRow): string {
  const choice = app.assignedRoomChoice?.trim() || app.application?.roomChoice1?.trim() || "";
  const { propertyId, listingRoomId } = parseRoomChoiceValue(choice);
  return listingRoomId ? `${propertyId}::${listingRoomId}` : "";
}

/** True when this application sits in a shared room that is let on one joint lease. */
export function applicationIsOnJointRoomLease(app: DemoApplicantRow): boolean {
  return sharedRoomIsOnJointLease(roomForApplicationRow(app));
}

/** The lead application and every roommate who will be on its joint lease; `[]` when the lease is not joint or the resident is alone. */
export function jointRoommateApplications(lead: DemoApplicantRow, apps: readonly DemoApplicantRow[]): DemoApplicantRow[] {
  if (!applicationIsOnJointRoomLease(lead)) return [];
  const group = lead.application?.groupId?.trim().toUpperCase();
  const key = roomKey(lead);
  if (!group || !key) return [];
  const mates = apps.filter(
    (app) =>
      app.id !== lead.id &&
      app.bucket === "approved" &&
      !app.withdrawnAt &&
      app.application?.groupId?.trim().toUpperCase() === group &&
      roomKey(app) === key,
  );
  return mates.length > 0 ? [lead, ...mates] : [];
}

export function jointRoomGroupIdFor(lead: DemoApplicantRow): string {
  const group = lead.application?.groupId?.trim().toUpperCase() ?? "";
  return `jointroom:${normalizeApplicationAxisId(group)}:${roomKey(lead)}`;
}

export type LinkJointRoomResult =
  | { ok: true; groupId: string; rows: LeasePipelineRow[] }
  | { ok: false; error: string };

/**
 * Make sure every roommate has a Draft lease and give them all the shared id. Idempotent. A roommate whose
 * lease is already out for signature or signed is left alone (the joint lease then covers the others).
 */
export function linkJointRoomLeases(
  lead: DemoApplicantRow,
  apps: readonly DemoApplicantRow[],
  managerUserId: string | null,
): LinkJointRoomResult {
  const roommates = jointRoommateApplications(lead, apps);
  if (roommates.length === 0) return { ok: false, error: "This resident is not on a joint lease." };
  const groupId = jointRoomGroupIdFor(lead);
  const rows: LeasePipelineRow[] = [];
  for (const app of roommates) {
    const ensured = ensureManagerReviewLeaseForApplication(app.id, managerUserId);
    if (!ensured.ok) return { ok: false, error: `${app.name || app.email || "A roommate"}: ${ensured.error}` };
    if (ensured.row.jointRoomGroupId !== groupId) {
      updateLeasePipelineRow(ensured.row.id, { jointRoomGroupId: groupId }, managerUserId);
    }
    rows.push({ ...ensured.row, jointRoomGroupId: groupId });
  }
  return { ok: true, groupId, rows };
}
