import { describe, expect, it } from "vitest";

import { generateIcsCalendar } from "@/lib/ical/generate";
import { parseIcsCalendar } from "@/lib/ical/parse";

const feed = (...events: string[]) =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", ...events.flatMap((lines) => ["BEGIN:VEVENT", lines, "END:VEVENT"]), "END:VCALENDAR"].join("\r\n");

describe("iCal export keeps DATE values (a DATE-TIME export breaks the channel's import)", () => {
  const ics = generateIcsCalendar([{ start: "2026-10-16", end: "2026-10-18" }], { calendarName: "Room A" });

  it("writes all-day DTSTART / DTEND and no times", () => {
    expect(ics).toContain("DTSTART;VALUE=DATE:20261016");
    expect(ics).toContain("DTEND;VALUE=DATE:20261019");
    expect(ics).not.toMatch(/DTSTART:|DTEND:|T\d{6}(?!Z)/);
  });

  it("emits no DESCRIPTION, so no guest detail and no times ride along", () => {
    expect(ics).not.toContain("DESCRIPTION");
    expect(ics).toContain("SUMMARY:Blocked");
  });
});

describe("iCal import: dates only means the property's default times apply", () => {
  it("an all-day event carries no times", () => {
    const [event] = parseIcsCalendar(feed("UID:a\r\nSUMMARY:Reserved\r\nDTSTART;VALUE=DATE:20261016\r\nDTEND;VALUE=DATE:20261019"));
    expect(event).toEqual({ uid: "a", summary: "Reserved", startDate: "2026-10-16", endDate: "2026-10-18" });
    expect(event).not.toHaveProperty("checkInTime");
    expect(event).not.toHaveProperty("checkOutTime");
  });
});

describe("iCal import: a local DATE-TIME keeps its wall times", () => {
  it("reads a floating start and end", () => {
    const [event] = parseIcsCalendar(feed("UID:b\r\nSUMMARY:Reserved\r\nDTSTART:20261016T150000\r\nDTEND:20261019T110000"));
    expect(event).toMatchObject({ startDate: "2026-10-16", endDate: "2026-10-18", checkInTime: "15:00", checkOutTime: "11:00" });
  });

  it("reads a TZID-pinned start and end", () => {
    const [event] = parseIcsCalendar(
      feed("UID:c\r\nSUMMARY:Reserved\r\nDTSTART;TZID=America/Los_Angeles:20261016T160000\r\nDTEND;TZID=America/Los_Angeles:20261019T100000"),
    );
    expect(event).toMatchObject({ checkInTime: "16:00", checkOutTime: "10:00", startDate: "2026-10-16", endDate: "2026-10-18" });
  });

  it("takes no time from a UTC value: an instant is not the property's wall clock", () => {
    const [event] = parseIcsCalendar(feed("UID:d\r\nSUMMARY:Reserved\r\nDTSTART:20261016T220000Z\r\nDTEND:20261019T180000Z"));
    expect(event).not.toHaveProperty("checkInTime");
    expect(event).not.toHaveProperty("checkOutTime");
  });

  it("ignores an end time on the same day as the start (a timed event, not a stay)", () => {
    const [event] = parseIcsCalendar(feed("UID:e\r\nSUMMARY:Reserved\r\nDTSTART:20261016T150000\r\nDTEND:20261016T170000"));
    expect(event).toMatchObject({ checkInTime: "15:00" });
    expect(event).not.toHaveProperty("checkOutTime");
  });
});
