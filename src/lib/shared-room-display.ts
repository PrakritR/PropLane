/**
 * Shared-room capacity display — when a room holds 2+ residents, rent is the
 * amount EACH resident pays (same for everyone; never split). Explained via
 * ColumnHelp "(i)", never muted subtext under the field.
 */

import { normalizeRoomOccupancyCapacity } from "@/lib/rental-application/room-occupancy";
import { formatRoomPriceAmount } from "@/lib/room-pricing";

export const RENT_PER_RESIDENT_HELP = {
  title: "Rent per resident",
  text: "When more than one resident lives in this room, the rent is the amount each resident pays. It is not split between them — every resident pays the same listed amount.",
} as const;

/** True when this room is configured for more than one simultaneous resident. */
export function roomHoldsMultipleResidents(
  room: { occupancyCapacity?: number | null } | null | undefined,
): boolean {
  return normalizeRoomOccupancyCapacity(room?.occupancyCapacity) >= 2;
}

/** Σ occupancyCapacity across rooms (Bookings / property list). */
export function totalResidentCapacity(
  rooms: readonly { occupancyCapacity?: number | null }[] | null | undefined,
): number {
  if (!rooms?.length) return 0;
  return rooms.reduce((sum, room) => sum + normalizeRoomOccupancyCapacity(room.occupancyCapacity), 0);
}

/**
 * Property-list residents glyph: only when at least one room holds 2+.
 * Returns the house total, or `null` to omit the glyph.
 */
export function propertyListResidentsGlyph(
  rooms: readonly { occupancyCapacity?: number | null }[] | null | undefined,
): number | null {
  if (!rooms?.length) return null;
  const hasShared = rooms.some((room) => roomHoldsMultipleResidents(room));
  if (!hasShared) return null;
  const total = totalResidentCapacity(rooms);
  return total > 0 ? total : null;
}

/** "2 residents · $1,000 each" for pricing card summaries. */
export function sharedRoomPricingSummaryLine(
  capacity: number,
  monthlyRent: number,
): string | null {
  if (capacity < 2) return null;
  const rent = monthlyRent > 0 ? `${formatRoomPriceAmount(monthlyRent)} each` : "rent per resident";
  return `${capacity} residents · ${rent}`;
}

/** Application / list fact: "Shared · 2 residents · $1,000/mo each". */
export function sharedRoomApplicationFact(
  capacity: number,
  monthlyRent: number | null | undefined,
): string | null {
  if (capacity < 2) return null;
  if (typeof monthlyRent === "number" && monthlyRent > 0) {
    return `Shared · ${capacity} residents · ${formatRoomPriceAmount(monthlyRent)}/mo each`;
  }
  return `Shared · ${capacity} residents`;
}

/** Public / lease one-liner under rent. */
export function rentPerResidentSubLabel(capacity: number): string | null {
  if (capacity < 2) return null;
  return "per resident · each pays the same";
}

/** Lease Premises / Rent sentence (plain English, no statute). */
export function leaseSharedRoomOccupancySentence(capacity: number, monthlyRentStr: string): string | null {
  if (capacity < 2) return null;
  return `This room may be occupied by up to ${capacity} residents. Rent of ${monthlyRentStr} is the amount each resident pays — it is not split between residents.`;
}
