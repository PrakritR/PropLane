/**
 * One availability decision for every PUBLIC room picker (the tour request's room dropdown, the Apply room
 * dropdown). It is the listing page's own decision, not a second one: the same `roomAvailability` predicate
 * over the same anonymous occupancy spans, worded by the same `openNowStatusText`, so a picker can never offer
 * a room the listing calls "Leased until ..." or "Not available" and never words an open room differently.
 *
 * Pure and client-safe.
 */
import type { PublicRoomOccupancy } from "@/lib/public-room-occupancy";
import { normalizeRoomOccupancyCapacity } from "@/lib/rental-application/room-occupancy";
import { findPublicRoomOccupancy } from "@/lib/public-listing-available-count";
import {
  PUBLIC_SOON_WINDOW_DAYS,
  openNowStatusText,
  publicStatusFromAvailability,
  roomAvailability,
  type PublicRoomStatus,
} from "@/lib/room-availability";

type PickRoom = {
  id: string;
  availability?: string | null;
  occupancyCapacity?: unknown;
  moveInAvailableDate?: string | null;
};

export type PublicRoomPick = {
  status: PublicRoomStatus;
  /** The listing's own wording: "Open now", "Opens Jan 1", "Leased until ...", "Not available". */
  label: string;
  /** For an open-now room: the last free day before its next booking (end-exclusive stays), else null. */
  openUntil: string | null;
  /** First day the room can be moved into (today for an open room); null for a leased or closed room. */
  availableFrom: string | null;
  /** A renter can apply for it: open now or opening on a date (any distance out). */
  applicable: boolean;
  /** A renter can tour it: open now, or opening within the listing's own "soon" window. */
  tourable: boolean;
};

function previousDay(day: string): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

/** The last free day before the next span that fills the room (spans' `end` is the last occupied day). */
function lastFreeDayBeforeNextBooking(spans: PublicRoomOccupancy["spans"], capacity: unknown, today: string): string | null {
  const cap = normalizeRoomOccupancyCapacity(capacity);
  const starts = spans.filter((span) => span.start > today && span.count >= cap).map((span) => span.start).sort();
  return starts.length ? previousDay(starts[0]!) : null;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

/**
 * The pick state of one room. `spans` are that room's occupancy spans (empty when the read has no row for it,
 * exactly as the listing treats a room with no row).
 */
export function publicRoomPick(
  room: PickRoom,
  spans: PublicRoomOccupancy["spans"],
  today: string,
): PublicRoomPick {
  const result = roomAvailability(
    { availability: room.availability, occupancyCapacity: room.occupancyCapacity, moveInAvailableDate: room.moveInAvailableDate },
    spans,
    today,
  );
  const status = publicStatusFromAvailability(result, spans, room.occupancyCapacity, today);
  const label = openNowStatusText(status, today);
  const open = status.kind === "now" || (status.kind === "soon" && Boolean(status.date));
  const availableFrom = status.kind === "now" ? today : status.kind === "soon" ? (status.date ?? null) : null;
  return {
    status,
    label,
    openUntil: status.kind === "now" ? lastFreeDayBeforeNextBooking(spans, room.occupancyCapacity, today) : null,
    availableFrom,
    applicable: open,
    tourable: status.kind === "now" || (status.kind === "soon" && Boolean(status.date) && daysBetween(today, status.date!) <= PUBLIC_SOON_WINDOW_DAYS),
  };
}

/** {@link publicRoomPick} for a room of one house, reading its spans out of the house's occupancy rows. */
export function publicRoomPickFromRows(
  room: PickRoom,
  rows: readonly PublicRoomOccupancy[],
  propertyId: string,
  today: string,
): PublicRoomPick {
  return publicRoomPick(room, findPublicRoomOccupancy(rows, propertyId, room.id)?.spans ?? [], today);
}
