import { isIcalAvailabilityBlock } from "@/lib/occupancy/snapshot";
import type { ChannelCalendarImportedRange } from "@/lib/channel-calendar/types";

export type IcalGuestStay = {
  connectionId: string;
  sourceUid: string;
  summary: string;
  start: string;
  end: string;
};

export function icalGuestStaysForResidents(
  connectionId: string,
  ranges: readonly ChannelCalendarImportedRange[],
): IcalGuestStay[] {
  return ranges
    .filter((range) => !isIcalAvailabilityBlock(range.summary))
    .map((range) => ({
      connectionId,
      sourceUid: (range.sourceUid || range.id).trim(),
      summary: range.summary.trim() || "Booked",
      start: range.start,
      end: range.end || range.start,
    }))
    .filter((stay) => stay.sourceUid && stay.start);
}

export function icalStayHasEnded(stay: Pick<IcalGuestStay, "end">, todayKey: string): boolean {
  return Boolean(stay.end && stay.end < todayKey);
}
