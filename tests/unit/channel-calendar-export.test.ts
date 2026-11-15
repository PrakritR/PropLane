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

  it("never echoes imported Airbnb stays but preserves manual blocks", () => {
    const sub = createDefaultListingSubmission();
    const room = sub.rooms[0]!;
    room.id = "r3";
    room.manualUnavailableRanges = [
      { id: `${CHANNEL_CALENDAR_IMPORTED_RANGE_PREFIX}-conn-1-uid`, start: "2026-09-01", end: "2026-09-10" },
      { id: "typed-1", start: "2026-09-20", end: "2026-09-22" },
    ];
    expect(roomUnavailableRangesForExport(sub, "r3")).toEqual([
      { start: "2026-09-20", end: "2026-09-22" },
    ]);
    const ranges = exportBlockedRanges({ typedBlocks: roomUnavailableRangesForExport(sub, "r3") });
    expect(ranges).toEqual([
      { start: "2026-09-20", end: "2026-09-22" },
    ]);
  });

  it("an empty room is a valid empty calendar", () => {
    const ics = generateIcsCalendar([], { calendarName: "Room 2", uidPrefix: "conn-empty" });
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("END:VCALENDAR");
    expect(ics).not.toContain("BEGIN:VEVENT");
  });
});

describe("export feed UIDs and line folding", () => {
  it("two ranges starting the same day get different UIDs, stable across builds", () => {
    const ranges = [{ start: "2026-09-15", end: "2026-09-16" }, { start: "2026-09-15", end: "2026-09-20" }];
    const uids = (ics: string) => ics.split("\r\n").filter((l) => l.startsWith("UID:"));
    const a = uids(generateIcsCalendar(ranges, { uidPrefix: "conn-1" }));
    const b = uids(generateIcsCalendar(ranges, { uidPrefix: "conn-1" }));
    expect(new Set(a).size).toBe(2);
    expect(a).toEqual(b);
  });

  it("an identical range twice still yields unique UIDs", () => {
    const r = { start: "2026-09-15", end: "2026-09-16" };
    const uids = generateIcsCalendar([r, r], { uidPrefix: "c" }).split("\r\n").filter((l) => l.startsWith("UID:"));
    expect(new Set(uids).size).toBe(2);
  });

  it("folds a long line at 75 octets with CRLF + space, never splitting a multi-byte character", () => {
    const ics = generateIcsCalendar([], { calendarName: "Café ".repeat(40) });
    for (const line of ics.split("\r\n")) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(ics).toContain("\r\n ");
    expect(ics.replace(/\r\n /g, "")).toContain("X-WR-CALNAME:" + "Café ".repeat(40).trim().replace(/,/g, "\\,"));
  });
});
