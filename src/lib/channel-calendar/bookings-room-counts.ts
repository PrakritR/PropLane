"use client";

/**
 * The real `roomCountForProperty` the Bookings occupancy math (`bookings-occupancy.ts`)
 * is injected with. Split out from that file because it reads the client-only
 * listing store — the occupancy math itself stays framework-free and testable.
 */

import { getPropertyById, isEntireHomeProperty } from "@/lib/rental-application/data";
import { normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

/** A whole-home listing, or a house with no room-level submission yet, is one occupancy unit. */
export function roomCountForProperty(propertyId: string): number {
  if (isEntireHomeProperty(propertyId)) return 1;
  const property = getPropertyById(propertyId);
  const submission = property?.listingSubmission;
  if (submission?.v !== 1) return 1;
  const rooms = normalizeManagerListingSubmissionV1(submission).rooms;
  return rooms.length > 0 ? rooms.length : 1;
}
