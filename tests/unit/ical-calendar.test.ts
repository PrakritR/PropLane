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
});
