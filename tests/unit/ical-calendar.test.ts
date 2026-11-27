import { describe, expect, it } from "vitest";

import { parseIcsCalendar } from "@/lib/ical/parse";
import { generateIcsCalendar } from "@/lib/ical/generate";

describe("parseIcsCalendar", () => {
  it("parses all-day VEVENT blocks with exclusive DTEND", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:abc123",
      "SUMMARY:Reserved",
      "DTSTART;VALUE=DATE:20260810",
      "DTEND;VALUE=DATE:20260813",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const events = parseIcsCalendar(ics);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      uid: "abc123",
      summary: "Reserved",
      startDate: "2026-08-10",
      endDate: "2026-08-12",
    });
  });

  it("unfolds folded lines", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:long-id",
      "SUMMARY:Airbnb (Not available)",
      "DTSTART;VALUE=DATE:20260701",
      "DTEND;VALUE=DATE:20260703",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\n");

    expect(parseIcsCalendar(ics)).toHaveLength(1);
  });
});

describe("generateIcsCalendar", () => {
  it("emits DATE values with exclusive DTEND", () => {
    const body = generateIcsCalendar([{ start: "2026-08-10", end: "2026-08-12" }]);
    expect(body).toContain("DTSTART;VALUE=DATE:20260810");
    expect(body).toContain("DTEND;VALUE=DATE:20260813");
    expect(body).toContain("BEGIN:VEVENT");
  });

  it("round-trips through parse with inclusive end dates", () => {
    const body = generateIcsCalendar([{ start: "2026-08-10", end: "2026-08-10" }]);
    const events = parseIcsCalendar(body);
    expect(events[0]?.startDate).toBe("2026-08-10");
    expect(events[0]?.endDate).toBe("2026-08-10");
  });

  it("cannot be made to inject a property through the calendar name", () => {
    const body = generateIcsCalendar([{ start: "2026-08-10", end: "2026-08-10" }], {
      calendarName: "Mine\r\nBEGIN:VEVENT\rX-EVIL:1\nSUMMARY:x",
    });
    // Every line of the feed is a known property; nothing the name carried starts its own line.
    const lines = body.split("\r\n").filter(Boolean);
    expect(lines.filter((line) => line.startsWith("BEGIN:VEVENT"))).toHaveLength(1);
    expect(lines.some((line) => line.startsWith("X-EVIL") || line.startsWith("SUMMARY:x"))).toBe(false);
    expect(body).not.toMatch(/\r(?!\n)/);
    expect(lines.find((line) => line.startsWith("X-WR-CALNAME:"))).toBe("X-WR-CALNAME:Mine\\nBEGIN:VEVENTX-EVIL:1\\nSUMMARY:x");
  });
});

describe("a one-night Airbnb reservation", () => {
  // Airbnb exports a one-night stay as DTSTART Dec 1 / DTEND Dec 2 (exclusive). PropLane stores the LAST NIGHT as the
  // end, so start == end is one night, not zero, and the export must close that night again (DTEND the next day).
  const airbnb = [
    "BEGIN:VCALENDAR",
    "PRODID;X-RICAL-TZSOURCE=TZINFO:-//Airbnb Inc//Hosting Calendar 1.0//EN",
    "BEGIN:VEVENT",
    "DTEND;VALUE=DATE:20261202",
    "DTSTART;VALUE=DATE:20261201",
    "UID:1418fb94e984-one-night@airbnb.com",
    "DESCRIPTION:Reservation URL: https://www.airbnb.com/hosting/reservations/de",
    " tails/HMTESTCODE\\nPhone Number (Last 4 Digits): 0000",
    "SUMMARY:Reserved",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  it("imports as start == end (the last night), and exports DTEND the day after", () => {
    const [event] = parseIcsCalendar(airbnb);
    expect(event).toMatchObject({ startDate: "2026-12-01", endDate: "2026-12-01" });
    const out = generateIcsCalendar([{ start: event!.startDate, end: event!.endDate }]);
    expect(out).toContain("DTSTART;VALUE=DATE:20261201");
    expect(out).toContain("DTEND;VALUE=DATE:20261202");
  });

  it("a multi-night stay keeps every night", () => {
    const [event] = parseIcsCalendar(airbnb.replace("DTEND;VALUE=DATE:20261202", "DTEND;VALUE=DATE:20261205"));
    expect(event).toMatchObject({ startDate: "2026-12-01", endDate: "2026-12-04" });
  });
});
