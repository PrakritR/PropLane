import type { ManagerRoomSubmission } from "@/lib/manager-listing-submission";
import { isHostBlockRange } from "@/lib/channel-calendar/host-block";
import { normalizeRoomOccupancyCapacity } from "@/lib/rental-application/room-occupancy";
import { occupiedBedSpans, occupiedBedsOn, nextDayKey, previousDayKey, type RoomBedSpan } from "@/lib/room-occupancy-rule";
import {
  deriveRoomAvailability,
  isChannelImportedRangeId,
  legacyMoveInDateAsSpan,
  formatDateKeyShort,
  manualRangesToSpans,
  todayDateKey,
} from "@/lib/room-availability-timeline";

/**
 * Plain-text pieces of the one-line fact row on a property-record list row
 * (studio-redesign property-tabs, 2026-10-03: "tile + title + ONE glyph-fact
 * line"). Pure strings so the rows stay thin and the wording is unit-tested;
 * the panels pair each string with its glyph.
 */

export function countWord(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "4 residents · 4 beds" — beds only when the manager said (`bedCount` is descriptive, never guessed from capacity). */
export function roomResidentsBedsText(room: Pick<ManagerRoomSubmission, "occupancyCapacity" | "bedCount">): string {
  const residents = Math.max(1, room.occupancyCapacity ?? 1);
  const parts = [countWord(residents, "resident")];
  if (typeof room.bedCount === "number" && room.bedCount > 0) parts.push(countWord(room.bedCount, "bed"));
  return parts.join(" · ");
}

/**
 * "Available now" · "Available from Nov 1, 2026" · "Occupied", derived from
 * the room's occupied dates the same way the listing wizard derives the public
 * label, so the row never contradicts the room editor.
 */
export function roomAvailabilityText(
  room: Pick<ManagerRoomSubmission, "manualUnavailableRanges" | "moveInAvailableDate">,
  today: string = todayDateKey(),
): string {
  const manual = manualRangesToSpans(room.manualUnavailableRanges);
  const spans = manual.length > 0 ? manual : [legacyMoveInDateAsSpan(room.moveInAvailableDate, today)].filter(
    (s): s is NonNullable<typeof s> => s !== null,
  );
  const readout = deriveRoomAvailability(spans, today);
  if (readout.occupiedNow && !readout.availableFrom) return "Occupied";
  // Dates on a row read "Oct 2, 2026", never the long form the public label uses.
  if (readout.occupiedNow && readout.availableFrom) return `Available from ${formatDateKeyShort(readout.availableFrom)}`;
  return readout.label;
}

/** The stays of the manager occupancy snapshot a room row needs: where, when, and whether it is a channel echo. */
export type RoomOccupancyStay = {
  roomId: string;
  /** Inclusive first / last day. */
  start: string;
  end: string;
  openEnded?: boolean;
  echoable?: boolean;
};

const ROOM_TEXT_HORIZON_DAYS = 800;

/**
 * The room row's availability from the SAME occupancy rule the public picker, the apply wizard
 * and the bots use: the snapshot's resident / channel / block stays on this room (a whole-home
 * stay takes every bed), plus the listing's own blocked dates, up to the room's capacity.
 *
 *   occupied now, ends E        -> "Occupied until <E>"
 *   occupied now, no end        -> "Occupied"
 *   free now, a stay starts S   -> "Available now until <S - 1>"
 *   closed only by the room's own "available from" date -> "Available from <date>"
 *   otherwise                   -> "Available now"
 */
export function roomAvailabilityTextFromOccupancy(
  room: Pick<ManagerRoomSubmission, "id" | "manualUnavailableRanges" | "moveInAvailableDate" | "occupancyCapacity">,
  stays: readonly RoomOccupancyStay[],
  today: string = todayDateKey(),
): string {
  const capacity = normalizeRoomOccupancyCapacity(room.occupancyCapacity);
  const ranges: RoomBedSpan[] = [];
  // The listing's own typed dates. A channel import / host block stored beside them is already a stay.
  for (const range of room.manualUnavailableRanges ?? []) {
    if (isChannelImportedRangeId(String(range.id ?? "")) || isHostBlockRange(range) || !range.start) continue;
    ranges.push({ start: range.start, end: range.end || null });
  }
  for (const stay of stays) {
    if (stay.roomId && stay.roomId !== room.id) continue;
    ranges.push({
      start: stay.start,
      end: stay.openEnded ? null : stay.end,
      count: stay.roomId ? 1 : capacity,
      ...(stay.echoable ? { echoable: true } : {}),
    });
  }
  const spans = occupiedBedSpans(ranges);
  const openFrom = /^\d{4}-\d{2}-\d{2}$/.test((room.moveInAvailableDate ?? "").trim()) ? room.moveInAvailableDate!.trim() : "";
  const closedOn = (day: string) => occupiedBedsOn(spans, day) >= capacity;
  const beforeOpening = (day: string) => Boolean(openFrom) && day < openFrom;
  const blocked = (day: string) => closedOn(day) || beforeOpening(day);

  let day = today;
  for (let i = 0; i < ROOM_TEXT_HORIZON_DAYS && blocked(day); i += 1) day = nextDayKey(day);
  if (blocked(day)) return "Occupied";
  if (day === today) {
    let next = nextDayKey(today);
    for (let i = 0; i < ROOM_TEXT_HORIZON_DAYS && !blocked(next); i += 1) next = nextDayKey(next);
    return blocked(next) ? `Available now until ${formatDateKeyShort(previousDayKey(next))}` : "Available now";
  }
  return closedOn(today) || closedOn(previousDayKey(day))
    ? `Occupied until ${formatDateKeyShort(previousDayKey(day))}`
    : `Available from ${formatDateKeyShort(day)}`;
}

/** Move-in row facts: whether instructions exist, how many photos, whether there is a video. */
export function moveInFactTexts(input: {
  instructions: string;
  photoCount: number;
  hasVideo: boolean;
}): { instructions: string; photos: string; video: string } {
  return {
    instructions: input.instructions.trim() ? "Instructions written" : "No instructions yet",
    photos: countWord(input.photoCount, "photo"),
    video: input.hasVideo ? "Video added" : "No video",
  };
}
