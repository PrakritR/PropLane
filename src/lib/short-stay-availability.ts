import type { PublicRoomOccupancy } from "@/lib/public-room-occupancy";
import {
  evaluateRoomOccupancy,
  normalizeRoomOccupancyCapacity,
  type RoomOccupancyPlacement,
} from "@/lib/rental-application/room-occupancy";

export function publicSpansToPlacements(spans: PublicRoomOccupancy["spans"]): RoomOccupancyPlacement[] {
  return spans.flatMap((span, index) =>
    Array.from({ length: Math.max(1, span.count) }, (_, bed) => ({
      id: `${index}:${bed}`,
      start: new Date(`${span.start}T12:00:00`),
      end: span.end ? new Date(`${span.end}T12:00:00`) : null,
    })),
  );
}

/** Check-out is exclusive: the last occupied night is the day before check-out. */
export function shortStayLastNight(checkOut: string): Date {
  const end = new Date(`${checkOut}T12:00:00`);
  end.setDate(end.getDate() - 1);
  return end;
}

export function shortStayRangeHasRoom(
  spans: PublicRoomOccupancy["spans"],
  capacity: number,
  checkIn: string,
  checkOut: string,
): boolean {
  const start = new Date(`${checkIn}T12:00:00`);
  const end = shortStayLastNight(checkOut);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end < start) return false;
  const placements: RoomOccupancyPlacement[] = [
    ...publicSpansToPlacements(spans),
    { id: "proposed-stay", start, end },
  ];
  const evaluation = evaluateRoomOccupancy({
    capacity: normalizeRoomOccupancyCapacity(capacity),
    placements,
    windowStart: start,
    windowEnd: end,
  });
  // A stay that fills the last bed is valid; `hasRoom` only means spare capacity remains.
  return evaluation.peakOccupancy <= evaluation.capacity;
}

export function publicSpansToCalendarSpans(
  spans: PublicRoomOccupancy["spans"],
): { start: Date; end: Date | null; tone: "occupied" }[] {
  return spans.map((span) => ({
    start: new Date(`${span.start}T12:00:00`),
    end: span.end ? new Date(`${span.end}T12:00:00`) : null,
    tone: "occupied" as const,
  }));
}
