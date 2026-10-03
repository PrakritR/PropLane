import type { ManagerRoomSubmission } from "@/lib/manager-listing-submission";
import {
  deriveRoomAvailability,
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
