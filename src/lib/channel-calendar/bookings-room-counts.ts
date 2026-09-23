"use client";

/**
 * Bed counts the Bookings occupancy math is injected with. Split out because
 * it reads the client-only listing store — the occupancy math itself stays
 * framework-free. House chrome that says “9 rooms” uses the same sum as the
 * snapshot: Σ occupancyCapacity, never rooms.length.
 */

import { getPropertyById, isEntireHomeProperty } from "@/lib/rental-application/data";
import { normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { normalizeRoomOccupancyCapacity } from "@/lib/rental-application/room-occupancy";
import type { OccupancyCapacities } from "@/lib/occupancy/snapshot";

/** A whole-home listing, or a house with no room-level submission yet, is one bed. */
export function bedCountForProperty(propertyId: string): number {
  if (isEntireHomeProperty(propertyId)) return 1;
  const property = getPropertyById(propertyId);
  const submission = property?.listingSubmission;
  if (submission?.v !== 1) return 1;
  const rooms = normalizeManagerListingSubmissionV1(submission).rooms;
  if (rooms.length === 0) return 1;
  return rooms.reduce((sum, room) => sum + normalizeRoomOccupancyCapacity(room.occupancyCapacity), 0);
}

export function roomCapacityForProperty(propertyId: string, roomId: string): number {
  if (!roomId || isEntireHomeProperty(propertyId)) return bedCountForProperty(propertyId);
  const property = getPropertyById(propertyId);
  const submission = property?.listingSubmission;
  if (submission?.v !== 1) return 1;
  const room = normalizeManagerListingSubmissionV1(submission).rooms.find((item) => item.id === roomId);
  return normalizeRoomOccupancyCapacity(room?.occupancyCapacity);
}

/** @deprecated Use {@link bedCountForProperty} — same number, old name. */
export function roomCountForProperty(propertyId: string): number {
  return bedCountForProperty(propertyId);
}

export const bookingOccupancyCapacities: OccupancyCapacities = {
  bedsTotal: bedCountForProperty,
  roomCapacity: roomCapacityForProperty,
};
