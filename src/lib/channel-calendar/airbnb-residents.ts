import { isIcalAvailabilityBlock } from "@/lib/occupancy/snapshot";
import { isHostBlockRange } from "@/lib/channel-calendar/host-block";
import type { ChannelCalendarImportedRange } from "@/lib/channel-calendar/types";

export type IcalGuestStay = {
  connectionId: string;
  sourceUid: string;
  summary: string;
  start: string;
  end: string;
};

/**
 * Airbnb writes every real reservation as "Reserved" (the guest is unnamed in the feed). It is a
 * booking, so it files a resident; a host block ("Not available") and a privacy-stripped
 * "CLOSED - Not available" do not.
 */
function isReservedSummary(summary: string | null | undefined): boolean {
  return String(summary ?? "").trim().toLowerCase() === "reserved";
}

export function icalGuestStaysForResidents(
  connectionId: string,
  ranges: readonly ChannelCalendarImportedRange[],
): IcalGuestStay[] {
  return ranges
    .filter((range) => !isHostBlockRange(range) && (isReservedSummary(range.summary) || !isIcalAvailabilityBlock(range.summary)))
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
