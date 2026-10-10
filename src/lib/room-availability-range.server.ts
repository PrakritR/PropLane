import "server-only";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { loadPublicRoomOccupancy } from "@/lib/public-room-occupancy.server";
import type { PublicRoomOccupancy } from "@/lib/public-room-occupancy";
import {
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import { roomAdvertisedPriceLabel } from "@/lib/room-pricing";
import {
  ROOM_AVAILABILITY_MAX_STAY_DAYS,
  evaluateRoomRange,
  normalizeRangeDay,
  rangeDaysBetween,
  type RoomRangeVerdict,
} from "@/lib/room-availability-range";

export type RoomRangeAvailability = {
  roomId: string;
  roomLabel: string;
  /** null = the occupancy read failed or the room data is unreadable: say it could not be verified. */
  available: boolean | null;
  firstConflict?: RoomRangeVerdict["firstConflict"];
  freeUntil?: string;
  nextAvailableFrom?: string;
  rentLabel: string | null;
  note?: string;
};

export type RoomAvailabilityForRangeResult =
  | { ok: false; error: "invalid_dates" | "room_not_found" | "listing_unreadable"; message: string }
  | {
      ok: true;
      propertyId: string;
      moveIn: string;
      moveOut: string | null;
      openEnded: boolean;
      verified: boolean;
      rooms: RoomRangeAvailability[];
    };

export type RoomAvailabilityForRangeInput = {
  propertyId: string;
  roomId?: string;
  /** YYYY-MM-DD */
  moveIn: string;
  /** YYYY-MM-DD, exclusive. Absent = open-ended (12 months ahead). */
  moveOut?: string;
};

export type RoomAvailabilityForRangeOptions = {
  /** The listing's submission, when the caller already holds it (a public-catalog projection or the owner's row). */
  submission?: unknown;
  /** Owner pin handed to loadPublicRoomOccupancy (omit for a workspace-scoped manager read). */
  expectedOwnerId?: string;
  /** Lets a caller share its own cached occupancy read. */
  loadOccupancy?: () => Promise<PublicRoomOccupancy[]>;
};

const NOT_VERIFIED = "Could not verify this room's calendar right now.";

/**
 * The one "is room X free from A to B" answer for prospects, residents and managers.
 * Reads the same occupancy the public listing page uses (executed leases, manual residents,
 * room blocks, imported Airbnb / Booking.com ranges, the manager's own unavailable ranges),
 * then applies the room's own move-in date and its resident capacity. Prospect-safe: dates,
 * labels and rent only - never a name, email, reservation code or source. A failed read is
 * `available: null`, never "available".
 */
export async function roomAvailabilityForRange(
  input: RoomAvailabilityForRangeInput,
  options: RoomAvailabilityForRangeOptions = {},
): Promise<RoomAvailabilityForRangeResult> {
  const moveIn = normalizeRangeDay(input.moveIn);
  const moveOut = input.moveOut?.trim() ? normalizeRangeDay(input.moveOut) : null;
  if (!moveIn || (input.moveOut?.trim() && !moveOut)) {
    return { ok: false, error: "invalid_dates", message: "moveIn and moveOut must be real dates as YYYY-MM-DD." };
  }
  if (moveOut && (moveOut <= moveIn || rangeDaysBetween(moveIn, moveOut) > ROOM_AVAILABILITY_MAX_STAY_DAYS)) {
    return { ok: false, error: "invalid_dates", message: "moveOut must be after moveIn and within three years." };
  }

  let submission: ManagerListingSubmissionV1 | null = null;
  try {
    const raw = options.submission as ManagerListingSubmissionV1 | undefined | null;
    submission = raw ? normalizeManagerListingSubmissionV1(raw as never) : null;
  } catch {
    submission = null;
  }
  if (!submission || !Array.isArray(submission.rooms)) {
    return { ok: false, error: "listing_unreadable", message: "This listing's rooms could not be read." };
  }
  const named = submission.rooms
    .map((room, index) => ({ room, label: room.name.trim() || `Room ${index + 1}` }))
    .filter(({ room }) => room.id);
  const wanted = input.roomId?.trim()
    ? named.filter(({ room }) => room.id === input.roomId!.trim())
    : named;
  if (!wanted.length) {
    return { ok: false, error: "room_not_found", message: "No room with that id on this listing." };
  }

  let occupancy: PublicRoomOccupancy[] | null = null;
  try {
    occupancy = options.loadOccupancy
      ? await options.loadOccupancy()
      : await loadPublicRoomOccupancy(
          createSupabaseServiceRoleClient(),
          [{ id: input.propertyId, listingSubmission: submission }],
          options.expectedOwnerId,
        );
  } catch {
    occupancy = null;
  }
  const spansByRoom = new Map(occupancy?.map((row) => [row.roomChoice, row.spans]) ?? []);

  const rooms: RoomRangeAvailability[] = wanted.slice(0, 40).map(({ room, label }) => {
    const rentLabel = roomAdvertisedPriceLabel(room, "") || null;
    const spans = spansByRoom.get(`${input.propertyId}::${room.id}`);
    if (!spans) {
      return { roomId: room.id, roomLabel: label, available: null, rentLabel, note: NOT_VERIFIED };
    }
    const verdict = evaluateRoomRange({
      spans,
      capacity: room.occupancyCapacity,
      availableFrom: room.moveInAvailableDate,
      moveIn,
      moveOut,
    });
    return {
      roomId: room.id,
      roomLabel: label,
      available: verdict.available,
      ...(verdict.firstConflict ? { firstConflict: verdict.firstConflict } : {}),
      ...(verdict.freeUntil ? { freeUntil: verdict.freeUntil } : {}),
      ...(verdict.nextAvailableFrom ? { nextAvailableFrom: verdict.nextAvailableFrom } : {}),
      rentLabel,
    };
  });
  return {
    ok: true,
    propertyId: input.propertyId,
    moveIn,
    moveOut,
    openEnded: !moveOut,
    verified: rooms.every((room) => room.available !== null),
    rooms,
  };
}
