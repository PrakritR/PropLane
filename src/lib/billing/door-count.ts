/**
 * Per-door billing — step 1: how many doors one listing counts as.
 *
 * Pure and dependency-light on purpose (no database, no server-only imports):
 * the same decision has to be reachable from a server snapshot job and, later,
 * from any UI that explains a bill to a manager, without dragging either along.
 *
 * The rule (captain-approved):
 * - A room-partitioned listing counts the SUM of each room's
 *   `occupancyCapacity` — a room that sleeps 4 is 4 doors, not 1 "room".
 * - A whole-home listing (`listingPlaceCategoryId === "entire_home"`) counts 1.
 *   This mirrors `isEntireHomeListing` in `manager-listing-submission.ts`
 *   (the rollback source of truth for that field) — kept as an inline
 *   comparison here rather than importing that 3000+ line module, since this
 *   file is deliberately narrow. If that helper's check ever changes, this
 *   comparison must move with it.
 * - A listing with NO ROOMS RECORDED counts 1 — never 0, and never the
 *   manager-typed `beds` field (`property-row-summary.ts`'s `propertyRowMeta`),
 *   which is descriptive copy, not a billing input. ~44% of live listings have
 *   no `rooms` array at all; billing them for rooms they never entered would
 *   silently overcharge (0 upside) or undercharge (0 doors) — 1 is the only
 *   answer that is never wrong in a way that costs the manager real money.
 *
 * Capacity itself is read through {@link normalizeRoomOccupancyCapacity}, the
 * same reader the capacity-enforcement code path uses
 * (`src/lib/rental-application/room-occupancy.ts`), so a room's bed count can
 * never disagree between what fills a bed and what bills for one. That reader
 * already clamps to 1..20 and never returns 0/NaN, which is why summing it is
 * safe without an extra guard per room.
 */

import { normalizeRoomOccupancyCapacity } from "@/lib/rental-application/room-occupancy";

export type DoorCountBasis = "rooms" | "whole-home" | "unrecorded";

export type DoorCountResult = {
  doors: number;
  basis: DoorCountBasis;
};

/** The narrowest shape this needs out of one room entry. */
type DoorCountRoomInput = {
  occupancyCapacity?: unknown;
};

/**
 * The narrowest shape this needs out of one listing's submission — a subset
 * of `ManagerListingSubmissionV1` (`src/lib/manager-listing-submission.ts`).
 * Callers extract this from the property record BEFORE calling in:
 * `row_data.submission` for a `pending` record, `property_data.listingSubmission`
 * for a `live`/`review` record (`door-count.server.ts` owns that extraction).
 */
export type DoorCountListingInput = {
  listingPlaceCategoryId?: unknown;
  rooms?: unknown;
};

/**
 * Doors for one listing, plus WHY — a bill has to be explainable line by
 * line, not just a number. Never throws: malformed or missing input reads as
 * 1 door, basis `"unrecorded"`, exactly like a listing that genuinely has no
 * rooms on file, since a billing function cannot tell those two cases apart
 * from data alone and must never resolve either to 0.
 */
export function doorCountForListing(input: unknown): DoorCountResult {
  if (!input || typeof input !== "object") return { doors: 1, basis: "unrecorded" };
  const listing = input as DoorCountListingInput;

  // Whole-home: one lease for the full unit, never priced per room. See
  // `isEntireHomeListing` — this is the same single comparison, kept inline.
  if (listing.listingPlaceCategoryId === "entire_home") {
    return { doors: 1, basis: "whole-home" };
  }

  const rooms = Array.isArray(listing.rooms) ? listing.rooms : null;
  if (!rooms || rooms.length === 0) {
    // No rooms recorded — never the manager-typed bedroom count, and never 0.
    return { doors: 1, basis: "unrecorded" };
  }

  const total = rooms.reduce((sum: number, room: unknown) => {
    const raw = room && typeof room === "object" ? (room as DoorCountRoomInput).occupancyCapacity : undefined;
    return sum + normalizeRoomOccupancyCapacity(raw);
  }, 0);

  // normalizeRoomOccupancyCapacity always returns a clamped 1..20 integer, so
  // `total` can only be non-finite or <= 0 here if `rooms` itself was empty,
  // which the guard above already handled — this is a belt-and-suspenders
  // floor, never expected to trigger.
  if (!Number.isFinite(total) || total <= 0) return { doors: 1, basis: "unrecorded" };

  return { doors: total, basis: "rooms" };
}
