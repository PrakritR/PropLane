import {
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
  type ManagerRoomSubmission,
  type RoomPricingUiMeta,
} from "@/lib/manager-listing-submission";
import {
  normalizeWorkspacePricingDefaults,
  workspaceDefaultRentForRoom,
  type WorkspacePricingDefaults,
} from "@/lib/workspace-pricing-defaults";
import { normalizeRoomOccupancyCapacity } from "@/lib/rental-application/room-occupancy";
import { offeredResidentCountsFor } from "@/lib/room-arrangement-pricing";
import { entireHomeMonthlyRentAmount } from "@/lib/manager-listing-submission";

export type PropertyPricingPublishResult = {
  submission: ManagerListingSubmissionV1;
  filledRooms: string[];
  filledWholeHouse: boolean;
};

function fillRoomFromDefaults(
  room: ManagerRoomSubmission,
  defaults: WorkspacePricingDefaults,
): { room: ManagerRoomSubmission; filled: boolean } {
  if (room.monthlyRent > 0) return { room, filled: false };
  const cap = normalizeRoomOccupancyCapacity(room.occupancyCapacity);
  const rent = workspaceDefaultRentForRoom(defaults, cap);
  if (!(rent && rent > 0)) return { room, filled: false };
  const offered = offeredResidentCountsFor(room);
  const occupancyPrices = offered.map((count) => ({
    count,
    monthlyRent: workspaceDefaultRentForRoom(defaults, count) ?? rent,
  }));
  return {
    room: {
      ...room,
      monthlyRent: rent,
      occupancyPrices,
      offeredResidentCounts: offered,
    },
    filled: true,
  };
}

/**
 * Fill unpriced rooms (and an offered whole house) from workspace defaults before publish.
 */
export function applyWorkspaceDefaultsOnPublish(
  sub: ManagerListingSubmissionV1,
  rawDefaults: unknown,
): PropertyPricingPublishResult {
  const defaults = normalizeWorkspacePricingDefaults(rawDefaults);
  const base = normalizeManagerListingSubmissionV1(sub);
  const filledRooms: string[] = [];
  const roomPricingMeta: Record<string, RoomPricingUiMeta> = { ...(base.roomPricingMeta ?? {}) };

  const rooms = base.rooms.map((room) => {
    const { room: next, filled } = fillRoomFromDefaults(room, defaults);
    if (filled) {
      filledRooms.push(room.name?.trim() || "Room");
      roomPricingMeta[room.id] = { ...(roomPricingMeta[room.id] ?? {}), priceSource: "default" };
    }
    return next;
  });

  let filledWholeHouse = false;
  let entireHomeMonthlyRent = base.entireHomeMonthlyRent;
  let entireHomePriceSource = base.entireHomePriceSource;
  if (base.entireHomeOffered && entireHomeMonthlyRentAmount(base) <= 0 && (defaults.rentWhole ?? 0) > 0) {
    entireHomeMonthlyRent = defaults.rentWhole;
    filledWholeHouse = true;
    entireHomePriceSource = "default";
  }

  return {
    submission: {
      ...base,
      rooms,
      roomPricingMeta,
      entireHomeMonthlyRent,
      entireHomePriceSource,
    },
    filledRooms,
    filledWholeHouse,
  };
}

/** Block publish when a room (or offered whole house) has no price and no default to fill. */
export function propertyPricingPublishBlocker(
  sub: ManagerListingSubmissionV1,
  rawDefaults: unknown,
): string | null {
  const defaults = normalizeWorkspacePricingDefaults(rawDefaults);
  const n = normalizeManagerListingSubmissionV1(sub);
  for (const room of n.rooms) {
    if (!room.name.trim() && room.monthlyRent <= 0) continue;
    if (room.monthlyRent > 0) continue;
    const cap = normalizeRoomOccupancyCapacity(room.occupancyCapacity);
    if (workspaceDefaultRentForRoom(defaults, cap)) continue;
    const label = room.name?.trim() || "Room";
    return `${label} needs a price — set it in Pricing or add a workspace default.`;
  }
  if (n.entireHomeOffered && entireHomeMonthlyRentAmount(n) <= 0 && !(defaults.rentWhole && defaults.rentWhole > 0)) {
    return "Whole house needs a price — set it in Pricing or add a workspace default.";
  }
  return null;
}

export function resetWholeHouseToWorkspaceDefault(
  sub: ManagerListingSubmissionV1,
  rawDefaults: unknown,
): ManagerListingSubmissionV1 | null {
  const defaults = normalizeWorkspacePricingDefaults(rawDefaults);
  const rentWhole = defaults.rentWhole ?? 0;
  if (!(rentWhole > 0)) return null;
  return {
    ...sub,
    entireHomeMonthlyRent: rentWhole,
    entireHomePriceSource: "default",
  };
}

export function resetRoomToWorkspaceDefault(
  sub: ManagerListingSubmissionV1,
  roomId: string,
  rawDefaults: unknown,
): ManagerListingSubmissionV1 | null {
  const defaults = normalizeWorkspacePricingDefaults(rawDefaults);
  const room = sub.rooms.find((r) => r.id === roomId);
  if (!room) return null;
  const { room: filled, filled: ok } = fillRoomFromDefaults(
    { ...room, monthlyRent: 0, occupancyPrices: undefined },
    defaults,
  );
  if (!ok) return null;
  const roomPricingMeta = {
    ...(sub.roomPricingMeta ?? {}),
    [roomId]: { ...(sub.roomPricingMeta?.[roomId] ?? {}), priceSource: "default" as const },
  };
  return {
    ...sub,
    rooms: sub.rooms.map((r) => (r.id === roomId ? filled : r)),
    roomPricingMeta,
  };
}
