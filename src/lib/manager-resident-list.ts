import {
  clusterRowsByResident,
  type ResidentCluster,
} from "@/lib/resident-row-clustering";
import { getPropertyById, parseRoomChoiceValue } from "@/lib/rental-application/data";
import { normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { roomPricesPerResident, roomResidentPriceForSlot } from "@/lib/room-pricing";
import { normalizeRoomOccupancyCapacity } from "@/lib/rental-application/room-occupancy";
import { sharedRoomApplicationFact } from "@/lib/shared-room-display";
import type { DemoApplicantRow } from "@/data/demo-portal";

export type ManagerResidentListRow = {
  id: string;
  name: string;
  email: string;
  propertyId: string;
  propertyLabel: string;
  roomLabel: string;
  leaseStart: string;
  /**
   * Where this person is in the application — "Incomplete", "Pending review",
   * "Approved". Only the Potential stage sets it: a current tenant's row is
   * about a tenancy, and repeating "Approved" on every one of them is noise.
   */
  statusLabel?: string;
  /**
   * Shared-room fact (PLAN-0924-0718): same rent each resident pays.
   */
  residentSlotFact?: string;
};

export type ManagerResidentListCluster = ResidentCluster<ManagerResidentListRow>;

export function residentHousingMeta(row: ManagerResidentListRow, includeProperty: boolean): string {
  return [row.roomLabel, includeProperty ? row.propertyLabel : null].filter(Boolean).join(" · ") || "—";
}

/**
 * Shared-room fact on a resident list row (PLAN-0924-0718): same rent each
 * resident pays — never unequal slot prices.
 */
export function residentRowSlotFact(row: DemoApplicantRow): string | undefined {
  const choice = (row.assignedRoomChoice || row.application?.roomChoice1 || "").trim();
  if (!choice) return undefined;
  const { propertyId, listingRoomId } = parseRoomChoiceValue(choice);
  if (!listingRoomId) return undefined;
  const property = getPropertyById(propertyId);
  if (!property?.listingSubmission || property.listingSubmission.v !== 1) return undefined;
  const submission = normalizeManagerListingSubmissionV1(property.listingSubmission);
  const room = submission.rooms.find((r) => r.id === listingRoomId);
  if (!room) return undefined;
  const capacity = normalizeRoomOccupancyCapacity(room.occupancyCapacity);
  const rent =
    room.monthlyRent > 0
      ? room.monthlyRent
      : roomPricesPerResident(room)
        ? roomResidentPriceForSlot(room, (row.application?.residentSlot as number) || 1)?.monthlyRent
        : undefined;
  return sharedRoomApplicationFact(capacity, rent) ?? undefined;
}

/** Group residents by identity — same rule as Tours, Payments, and Applications. */
export function clusterManagerResidentListRows(
  rows: readonly ManagerResidentListRow[],
): ManagerResidentListCluster[] {
  return clusterRowsByResident(
    rows.map((row) => ({
      ...row,
      residentName: row.name,
      residentEmail: row.email,
    })),
    (row) => row.propertyLabel || null,
  );
}
