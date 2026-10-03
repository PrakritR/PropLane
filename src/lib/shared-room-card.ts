/**
 * The Shared room card on an application — room, bed, rent, lease type and beds taken, then
 * every roommate's status with an Approve or Remind icon of their own.
 *
 * Read off the same sources approval uses (`application-approval-slots.ts` for beds and who
 * holds them, the group reconciliation for roommates), never a second count. Approving is per
 * resident; a group never blocks, so a roommate who has not applied is a fact, not a gate.
 */
import type { DemoApplicantRow } from "@/data/demo-portal";
import { bedLabelForSlot, roomForApplicationRow, residentSlotsForApplicationRow } from "@/lib/application-approval-slots";
import type { ApplicationGroup } from "@/lib/rental-application/application-groups";
import { applicantDisplayName } from "@/lib/rental-application/applicant-name";
import { isInProgressApplicationRow } from "@/lib/rental-application/in-progress-application";
import { isWithdrawnApplicationRow } from "@/lib/rental-application/resident-application-list";
import { normalizeRoomOccupancyCapacity } from "@/lib/rental-application/room-occupancy";
import { sharedRoomIsOnJointLease } from "@/lib/leasing-pipeline-client-cache";
import { formatRoomPriceAmount, roomResidentPriceForSlot } from "@/lib/room-pricing";

export type SharedRoomRoommate = {
  id: string;
  name: string;
  /** "Approved" · "Submitted" · "Incomplete" · "Declined" · "Withdrawn" */
  statusWord: string;
  approved: boolean;
  bedLabel: string | null;
  rentLabel: string | null;
  isThis: boolean;
  /** The one icon this roommate's row offers. */
  action: "approve" | "remind" | null;
};

export type SharedRoomCardModel = {
  roomName: string;
  capacity: number;
  /** "Bed A", marked requested while the application is undecided. */
  bedLabel: string | null;
  bedRequested: boolean;
  rentLabel: string | null;
  leaseLabel: string;
  joint: boolean;
  taken: number;
  roommates: SharedRoomRoommate[];
  /** Roommates the group declared that have not started an application. */
  notApplied: number;
};

export function statusWordForRow(row: DemoApplicantRow): string {
  if (isWithdrawnApplicationRow(row)) return "Withdrawn";
  if (row.bucket === "approved") return "Approved";
  if (row.bucket === "rejected") return "Declined";
  if (isInProgressApplicationRow(row)) return "Incomplete";
  return "Submitted";
}

function rentFor(row: DemoApplicantRow, room: NonNullable<ReturnType<typeof roomForApplicationRow>>): string | null {
  const slot = Number(row.application?.residentSlot);
  const price = Number.isInteger(slot) && slot > 0 ? roomResidentPriceForSlot(room, slot, row.application?.leaseTerm) : undefined;
  const rent = price?.monthlyRent ?? (room.monthlyRent > 0 ? room.monthlyRent : 0);
  return rent > 0 ? `${formatRoomPriceAmount(rent)}/mo` : null;
}

export function sharedRoomCardFor(
  row: DemoApplicantRow,
  allRows: readonly DemoApplicantRow[],
  group: ApplicationGroup | null,
): SharedRoomCardModel | null {
  const room = roomForApplicationRow(row);
  if (!room) return null;
  const capacity = normalizeRoomOccupancyCapacity(room.occupancyCapacity);
  if (capacity < 2) return null;

  const slots = residentSlotsForApplicationRow(row);
  const taken = slots.filter((s) => s.holder && !(row.bucket === "approved" && Number(row.application?.residentSlot) === s.slot)).length + (row.bucket === "approved" ? 1 : 0);
  const slot = Number(row.application?.residentSlot);
  const hasSlot = Number.isInteger(slot) && slot > 0;
  const joint = sharedRoomIsOnJointLease(room);

  const memberRows: DemoApplicantRow[] = [];
  if (group) {
    for (const m of group.members) {
      const r = allRows.find((candidate) => candidate.id === m.id);
      if (r) memberRows.push(r);
    }
  }
  if (!memberRows.some((r) => r.id === row.id)) memberRows.unshift(row);

  const roommates: SharedRoomRoommate[] = memberRows.map((r) => {
    const status = statusWordForRow(r);
    const s = Number(r.application?.residentSlot);
    const approvable = r.bucket === "pending" && !isWithdrawnApplicationRow(r) && !isInProgressApplicationRow(r);
    return {
      id: r.id,
      name: applicantDisplayName(r),
      statusWord: status,
      approved: r.bucket === "approved",
      bedLabel: Number.isInteger(s) && s > 0 ? bedLabelForSlot(s) : null,
      rentLabel: rentFor(r, room),
      isThis: r.id === row.id,
      action: approvable ? "approve" : r.bucket === "pending" && !isWithdrawnApplicationRow(r) ? "remind" : null,
    };
  });

  return {
    roomName: room.name?.trim() || "Shared room",
    capacity,
    bedLabel: hasSlot ? bedLabelForSlot(slot) : null,
    bedRequested: row.bucket !== "approved",
    rentLabel: rentFor(row, room),
    leaseLabel: joint ? "One joint lease for roommates" : "One lease per resident",
    joint,
    taken: Math.min(capacity, taken),
    roommates,
    notApplied: group?.missingCount && group.missingCount > 0 ? group.missingCount : 0,
  };
}
