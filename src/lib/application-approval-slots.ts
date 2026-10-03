/**
 * Which room and which bed an application is being approved into.
 *
 * The one reader behind the Approve popup, the Shared room card on an
 * application, and the last-bed conflict answer — so all three agree on which
 * beds exist, who holds them, and what each costs. Pure over the application
 * rows already in the browser's cache and the listing catalog; the server
 * re-derives the same decision inside the write that takes the bed
 * (`resolveApprovedResidentSlot` in `/api/manager-applications`), so anything
 * read here is a preview, never the authority.
 */
import type { DemoApplicantRow } from "@/data/demo-portal";
import { openResidentSlotsForApplicationRow } from "@/lib/manager-applications-storage";
import { normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { getPropertyById, parseRoomChoiceValue } from "@/lib/rental-application/data";
import {
  normalizeRoomOccupancyCapacity,
  type OpenResidentSlot,
} from "@/lib/rental-application/room-occupancy";
import { formatRoomPriceAmount, roomPricesPerResident } from "@/lib/room-pricing";
import { bedLabelForSlot } from "@/lib/shared-room-display";

export { bedLabelForSlot };

/**
 * The listing room this application is placed in — the manager's final
 * `assignedRoomChoice`, else the applicant's own first choice. Undefined for a
 * whole-property placement or a row that names no room.
 */
export function roomForApplicationRow(row: DemoApplicantRow) {
  const choice = row.assignedRoomChoice?.trim() || row.application?.roomChoice1?.trim() || "";
  if (!choice) return undefined;
  const { propertyId, listingRoomId } = parseRoomChoiceValue(choice);
  if (!listingRoomId) return undefined;
  const property = getPropertyById(propertyId);
  if (!property?.listingSubmission || property.listingSubmission.v !== 1) return undefined;
  const sub = normalizeManagerListingSubmissionV1(property.listingSubmission);
  return sub.rooms.find((r) => r.id === listingRoomId);
}

/** Every bed of this application's room (open and held); `[]` when the room is not shared. */
export function residentSlotsForApplicationRow(row: DemoApplicantRow): OpenResidentSlot[] {
  const room = roomForApplicationRow(row);
  return room ? openResidentSlotsForApplicationRow(row, room) : [];
}

export type ApprovalBedOption = {
  slot: number;
  /** "Bed A · $650/mo" */
  label: string;
  rentLabel: string;
  monthlyRent: number;
  /** Held by somebody else right now. */
  heldBy: string | null;
};

/** The beds a manager can still pick for this application (its own current bed stays pickable). */
export function approvalBedOptions(row: DemoApplicantRow, slots: OpenResidentSlot[]): ApprovalBedOption[] {
  const own = Number(row.application?.residentSlot);
  return slots
    .filter((s) => !s.holder || (Number.isInteger(own) && own === s.slot && row.bucket === "approved"))
    .map((s) => {
      const rentLabel = s.price.monthlyRent > 0 ? `${formatRoomPriceAmount(s.price.monthlyRent)}/mo` : "Rent not set";
      return {
        slot: s.slot,
        label: `${bedLabelForSlot(s.slot)} · ${rentLabel}`,
        rentLabel,
        monthlyRent: s.price.monthlyRent,
        heldBy: null,
      };
    });
}

/** True when the application's room is priced per resident (each bed its own rent). */
export function applicationRoomPricesPerResident(row: DemoApplicantRow): boolean {
  const room = roomForApplicationRow(row);
  return Boolean(room && roomPricesPerResident(room, row.application?.leaseTerm));
}

/** True when the application sits in a room with two or more beds. */
export function applicationIsInSharedRoom(row: DemoApplicantRow): boolean {
  const room = roomForApplicationRow(row);
  return Boolean(room && normalizeRoomOccupancyCapacity(room.occupancyCapacity) >= 2);
}
