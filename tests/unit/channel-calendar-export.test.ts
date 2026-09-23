import { describe, expect, it } from "vitest";
import { exportBlockedRanges } from "@/lib/occupancy/snapshot";
import { generateIcsCalendar } from "@/lib/ical/generate";
import { roomUnavailableRangesForExport } from "@/lib/channel-calendar/connections.server";
import { CHANNEL_CALENDAR_IMPORTED_RANGE_PREFIX } from "@/lib/channel-calendar/types";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";

describe("channel calendar export ICS", () => {
  it("a lease on Room 3 appears as Blocked and a Not available import does not", () => {
    const ranges = exportBlockedRanges({
      leases: [{ start: "2026-09-15", end: "2026-09-30" }],
    });
    const ics = generateIcsCalendar(ranges, { calendarName: "Room 3", uidPrefix: "conn-room-3" });
    expect(ics).toContain("SUMMARY:Blocked");
    expect(ics).toContain("UID:conn-room-3-2026-09-15");
    expect(ics).not.toContain("Not available");
    expect(ics).not.toContain("Vedel");
  });

  it("does not re-export an imported iCal range stored on the listing", () => {
    const sub = createDefaultListingSubmission();
    const room = sub.rooms[0]!;
    room.id = "r3";
    room.manualUnavailableRanges = [
      { id: `${CHANNEL_CALENDAR_IMPORTED_RANGE_PREFIX}-conn-1-uid`, start: "2026-09-01", end: "2026-09-10" },
      { id: "typed-1", start: "2026-09-20", end: "2026-09-22" },
    ];
    expect(roomUnavailableRangesForExport(sub, "r3")).toEqual([{ start: "2026-09-20", end: "2026-09-22" }]);
  });

  it("an empty room is a valid empty calendar", () => {
    const ics = generateIcsCalendar([], { calendarName: "Room 2", uidPrefix: "conn-empty" });
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("END:VCALENDAR");
    expect(ics).not.toContain("BEGIN:VEVENT");
  });
});
