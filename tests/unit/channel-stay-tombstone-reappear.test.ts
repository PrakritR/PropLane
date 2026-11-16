import { describe, expect, it } from "vitest";

import { icalEventsToImportedRanges } from "@/lib/channel-calendar/sync.server";
import {
  channelStayTombstoneKeyOf,
  pruneTombstonedRanges,
  tombstoneKeySetOf,
  type ChannelStayTombstone,
} from "@/lib/channel-calendar/stay-tombstones";
import { parseIcsCalendar } from "@/lib/ical/parse";
import { isHostBlockRange } from "@/lib/channel-calendar/host-block";

/**
 * Ops report, Nov 15: Booking.com reservation 6172306881 (4709A Room 8, Nov 14-15, one night) was not in PropLane.
 * Production evidence: the room's Booking.com connection synced cleanly (no last_error), and a `channel_stay_tombstone`
 * for its privacy-stripped "CLOSED - Not available" UID, Nov 14, one night, had been written by the manager at
 * 23:22 PT Nov 14. The importer prunes a tombstoned UID on every cron sync, and a stay the feed still lists is never
 * un-removed by the cron. The feed parse itself is sound for a one-night, date-only reservation.
 */
const ROOM = { propertyId: "p", roomId: "room-8", provider: "booking_com" };
const FEED = (start: string, end: string) =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:565a9a0f66493721f747aa72945e72c3@booking.com",
    "SUMMARY:CLOSED - Not available",
    `DTSTART;VALUE=DATE:${start}`,
    `DTEND;VALUE=DATE:${end}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

const tombstone: ChannelStayTombstone = {
  ...ROOM,
  sourceUid: "565a9a0f66493721f747aa72945e72c3@booking.com",
  range: { id: "565a9a0f66493721f747aa72945e72c3@booking.com", sourceUid: "565a9a0f66493721f747aa72945e72c3@booking.com", summary: "CLOSED - Not available", start: "2026-11-14", end: "2026-11-14" },
  removedAt: "2026-11-15T07:22:57.929Z",
};

describe("a one-night Booking.com reservation in the feed", () => {
  it("parses as one stay (not a host block) covering exactly the night of Nov 14", () => {
    const ranges = icalEventsToImportedRanges(parseIcsCalendar(FEED("20261114", "20261115")));
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toMatchObject({ start: "2026-11-14", end: "2026-11-14", summary: "CLOSED - Not available" });
    expect(isHostBlockRange(ranges[0]!)).toBe(false);
  });

  it("root cause: a removal tombstone on the same UID and dates keeps it out of every sync", () => {
    const ranges = icalEventsToImportedRanges(parseIcsCalendar(FEED("20261114", "20261115")));
    const keys = tombstoneKeySetOf([tombstone]);
    expect(keys.has(channelStayTombstoneKeyOf(tombstone))).toBe(true);
    const out = pruneTombstonedRanges(ranges, ROOM, keys);
    expect(out.kept).toEqual([]);
    expect(out.dropped).toHaveLength(1);
  });

  it("fix: the same UID listed with DIFFERENT dates (a changed or rebooked stay) is stored again", () => {
    const changed = icalEventsToImportedRanges(parseIcsCalendar(FEED("20261114", "20261116")));
    const out = pruneTombstonedRanges(changed, ROOM, tombstoneKeySetOf([tombstone]));
    expect(out.kept).toHaveLength(1);
    expect(out.dropped).toEqual([]);
  });

  it("a plain Set of keys (no recorded dates) still prunes by UID alone, as before", () => {
    const changed = icalEventsToImportedRanges(parseIcsCalendar(FEED("20261114", "20261116")));
    const out = pruneTombstonedRanges(changed, ROOM, new Set([channelStayTombstoneKeyOf(tombstone)]));
    expect(out.kept).toEqual([]);
  });
});
