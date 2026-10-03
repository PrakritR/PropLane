import type { PublicRoomOccupancy } from "@/lib/public-room-occupancy";
import { formatRoomPriceAmount } from "@/lib/room-pricing";
import {
  evaluateRoomOccupancy,
  normalizeRoomOccupancyCapacity,
  type OpenResidentSlot,
} from "@/lib/rental-application/room-occupancy";
import { roomHoldsMultipleResidents } from "@/lib/shared-room-display";

const BED_LETTERS = "ABCDEFGHIJKLMNOPQRST";

export function sharedRoomBedLabel(slot: number): string {
  const letter = BED_LETTERS.charAt(slot - 1);
  return letter ? `Bed ${letter}` : `Bed ${slot}`;
}

export type SharedRoomBedRow = {
  slot: number;
  label: string;
  priceLabel: string;
  statusLabel: string;
  available: boolean;
};

/** Anonymous bed line for listing modal — never includes holder names. */
export function sharedRoomBedRowsFromSlots(slots: OpenResidentSlot[]): SharedRoomBedRow[] {
  return slots.map((entry) => {
    const available = !entry.holder;
    const sinceRaw = entry.holder?.since;
    const until =
      sinceRaw != null
        ? formatOccupiedUntilLabel(
            sinceRaw instanceof Date ? sinceRaw.toISOString() : String(sinceRaw),
          )
        : null;
    return {
      slot: entry.slot,
      label: sharedRoomBedLabel(entry.slot),
      priceLabel: `${formatRoomPriceAmount(entry.price.monthlyRent)}/mo`,
      statusLabel: available ? "Available now" : until ? `Occupied until ${until}` : "Occupied",
      available,
    };
  });
}

function formatOccupiedUntilLabel(isoOrDate: string): string | null {
  const d = new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

export function sharedRoomListingHeadline(capacity: number, openBeds: number): string | null {
  if (!roomHoldsMultipleResidents({ occupancyCapacity: capacity })) return null;
  const beds = normalizeRoomOccupancyCapacity(capacity);
  const open = Math.max(0, Math.min(beds, openBeds));
  return `Shared room · ${beds} beds · ${open} open`;
}

export function sharedRoomOpenBedsLine(capacity: number, openBeds: number): string | null {
  if (!roomHoldsMultipleResidents({ occupancyCapacity: capacity })) return null;
  const beds = normalizeRoomOccupancyCapacity(capacity);
  const open = Math.max(0, Math.min(beds, openBeds));
  return `${open} of ${beds} beds open`;
}

/** Per-bed rent cell: single price or "from $X/bed". */
export function sharedRoomRentCellLabel(monthlyRents: number[]): string {
  const positive = monthlyRents.filter((n) => n > 0);
  if (!positive.length) return "—";
  const min = Math.min(...positive);
  const max = Math.max(...positive);
  if (min === max) return `${formatRoomPriceAmount(min)}/bed`;
  return `from ${formatRoomPriceAmount(min)}/bed`;
}

export function publicRoomOpenBedCount(
  capacity: number,
  spans: PublicRoomOccupancy["spans"],
  at = new Date(),
): number {
  const cap = normalizeRoomOccupancyCapacity(capacity);
  if (cap < 2) return cap > 0 ? 1 : 0;
  const today = new Date(at.getFullYear(), at.getMonth(), at.getDate());
  const placements = spans.flatMap((span, index) =>
    Array.from({ length: span.count }, (_, bed) => ({
      id: `${index}:${bed}`,
      start: new Date(`${span.start}T12:00:00`),
      end: span.end ? new Date(`${span.end}T12:00:00`) : null,
    })),
  );
  const { remaining } = evaluateRoomOccupancy({
    capacity: cap,
    placements,
    windowStart: today,
    windowEnd: today,
  });
  return remaining;
}

export function sharedRoomBaseRentCardLabel(monthlyRents: number[]): string | null {
  const positive = monthlyRents.filter((n) => n > 0);
  if (!positive.length) return null;
  const min = Math.min(...positive);
  const max = Math.max(...positive);
  if (min === max) return `Base rent ${formatRoomPriceAmount(min)}/bed`;
  return `Base rent from ${formatRoomPriceAmount(min)}/bed`;
}
