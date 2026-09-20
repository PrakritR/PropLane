import {
  clusterRowsByResident,
  type ResidentCluster,
} from "@/lib/resident-row-clustering";
import { getPropertyById, parseRoomChoiceValue } from "@/lib/rental-application/data";
import { normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { formatRoomPriceAmount, roomPricesPerResident, roomResidentPriceForSlot } from "@/lib/room-pricing";
import { normalizeRoomOccupancyCapacity } from "@/lib/rental-application/room-occupancy";
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
   * "Resident 2 of 2 · $800/mo" — populated when the resident is in a
   * multi-occupancy room and their slot is known.
   */
  residentSlotFact?: string;
};

export type ManagerResidentListCluster = ResidentCluster<ManagerResidentListRow>;

export function residentHousingMeta(row: ManagerResidentListRow, includeProperty: boolean): string {
  return [row.roomLabel, includeProperty ? row.propertyLabel : null].filter(Boolean).join(" · ") || "—";
}

export function residentRowSlotFact(row: DemoApplicantRow): string | undefined {
  const slot = row.application?.residentSlot;
  if (!Number.isInteger(slot) || (slot as number) < 1) return undefined;
  const choice = (row.assignedRoomChoice || row.application?.roomChoice1 || "").trim();
  if (!choice) return undefined;
  const { propertyId, listingRoomId } = parseRoomChoiceValue(choice);
  if (!listingRoomId) return undefined;
  const property = getPropertyById(propertyId);
  if (!property?.listingSubmission || property.listingSubmission.v !== 1) return undefined;
  const submission = normalizeManagerListingSubmissionV1(property.listingSubmission);
  const room = submission.rooms.find((r) => r.id === listingRoomId);
  if (!room || !roomPricesPerResident(room)) return undefined;
  const capacity = normalizeRoomOccupancyCapacity(room.occupancyCapacity);
  const rent = roomResidentPriceForSlot(room, slot as number)?.monthlyRent;
  return rent ? `Resident ${slot} of ${capacity} · ${formatRoomPriceAmount(rent)}/mo` : `Resident ${slot} of ${capacity}`;
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
