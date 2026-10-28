/**
 * The public availability label of every room, computed from live occupancy spans and never from the saved
 * `availability` string (that string is typed once by a manager and went stale on 24 of 28 leased rooms).
 *
 * Pure and client-safe. `getPublicListings` runs `applyLiveRoomAvailability` last, so every public reader of the
 * catalog (browse cards, listing page, syndication feeds, share cards, the assistant's `list_live_listings`) starts
 * from the same words: "Available now", "Available <date>" (frees within 60 days), "Leased until <date>", "Not available".
 */
import type { MockProperty } from "@/data/types";
import { findPublicRoomOccupancyExact } from "@/lib/public-listing-available-count";
import { pacificListingDay, type PublicRoomOccupancy } from "@/lib/public-room-occupancy";
import { publicRoomStatus, type PublicRoomStatus } from "@/lib/room-availability";

/** Pacific wall day as YYYY-MM-DD. */
export function pacificTodayKey(now = new Date()): string {
  const day = pacificListingDay(now);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
}

/**
 * Returns the same listings with each room's `availability` replaced by its live label. A room with no occupancy row
 * is read as having no spans (vacant); pass `rows = null` when the occupancy read failed and the listings come back
 * untouched, because a failed read must never turn a saved label into a verified one.
 */
export function applyLiveRoomAvailability(
  listings: readonly MockProperty[],
  rows: readonly PublicRoomOccupancy[] | null,
  today: string = pacificTodayKey(),
): MockProperty[] {
  if (!rows) return [...listings];
  return listings.map((listing) => {
    const submission = listing.listingSubmission;
    if (!submission || submission.v !== 1 || !submission.rooms?.length) return listing;
    const statuses: PublicRoomStatus[] = [];
    const rooms = submission.rooms.map((room) => {
      // Exact key only: `rows` is the WHOLE catalog's snapshot, where a `::<roomId>` suffix match would hand this
      // room another house's spans and publish a wrong "Leased until ..." for it.
      const found = findPublicRoomOccupancyExact(rows, listing.id, room.id);
      // No row for the room means the snapshot never saw it (a room added after it was built): keep what was saved.
      if (!found) return room;
      const status = publicRoomStatus(room, found.spans, today);
      statuses.push(status);
      return { ...room, availability: status.text };
    });
    return {
      ...listing,
      // The house line (feeds' availableOn, JSON-LD) follows its rooms: open now, else the first date one frees.
      ...(statuses.length ? { available: houseAvailability(statuses) } : {}),
      listingSubmission: { ...submission, rooms },
    };
  });
}

function houseAvailability(statuses: readonly PublicRoomStatus[]): string {
  if (statuses.some((status) => status.kind === "now")) return "Available now";
  const soonest = statuses.filter((status) => status.kind === "soon" && status.date).sort((a, b) => a.date!.localeCompare(b.date!))[0];
  return soonest?.text ?? "Not available";
}

export type { PublicRoomStatus };
