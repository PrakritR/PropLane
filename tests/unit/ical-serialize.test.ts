import { describe, expect, it } from "vitest";
import { buildIcsTimedCalendar, escapeIcsText, foldIcsLine } from "@/lib/ical/serialize";
import { vendorJobToFeedEvent, vendorJobsToFeedEvents } from "@/lib/vendor-calendar-feed-events";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";

const NOW = new Date("2026-10-06T12:00:00Z");

function row(overrides: Partial<DemoManagerWorkOrderRow> = {}): DemoManagerWorkOrderRow {
  return {
    id: "wo-1",
    propertyName: "Maple House",
    unit: "—",
    title: "Fix sink",
    priority: "normal",
    status: "Scheduled",
    bucket: "scheduled",
    description: "Leaking trap",
    scheduled: "",
    cost: "",
    propertyAddress: "123 Main St, Seattle, WA 98101",
    scheduledAtIso: "2026-10-08T17:00:00.000Z",
    vendorId: "v1",
    vendorName: "Apex",
    ...overrides,
  } as DemoManagerWorkOrderRow;
}

describe("iCal serializer", () => {
  it("escapes backslash, semicolon, comma and newlines, and drops bare CRs", () => {
    expect(escapeIcsText("a\\b;c,d\ne\r\nf\rg")).toBe("a\\\\b\\;c\\,d\\ne\\nf\\ng");
  });

  it("a semicolon or comma inside a title is escaped in the serialized line, never left to split the value", () => {
    const body = buildIcsTimedCalendar(
      [{
        uid: "a",
        summary: "Fix sink; replace trap, then test",
        start: new Date("2026-10-08T17:00:00Z"),
        end: new Date("2026-10-08T18:00:00Z"),
        location: "123 Main St; Unit 2, Seattle",
      }],
      { calendarName: "PropLane jobs", now: NOW },
    );
    expect(body).toContain("SUMMARY:Fix sink\\; replace trap\\, then test\r\n");
    expect(body).toContain("LOCATION:123 Main St\\; Unit 2\\, Seattle\r\n");
    expect(body).not.toMatch(/SUMMARY:[^\r\n]*[^\\];/);
  });

  it("uses CRLF everywhere and wraps events in a VCALENDAR with the calendar name", () => {
    const body = buildIcsTimedCalendar(
      [{ uid: "a@proplane.ai", summary: "Fix sink", start: new Date("2026-10-08T17:00:00Z"), end: new Date("2026-10-08T18:00:00Z") }],
      { calendarName: "PropLane jobs", now: NOW },
    );
    expect(body.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(body.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(body.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    expect(body).toContain("X-WR-CALNAME:PropLane jobs\r\n");
    expect(body).toContain("UID:a@proplane.ai\r\n");
    expect(body).toContain("DTSTAMP:20261006T120000Z\r\n");
    expect(body).toContain("DTSTART:20261008T170000Z\r\n");
    expect(body).toContain("DTEND:20261008T180000Z\r\n");
    expect(body).toContain("SUMMARY:Fix sink\r\n");
  });

  it("folds lines over 75 octets, never inside a multi-byte character, and unfolds back losslessly", () => {
    const summary = `Replace ${"é".repeat(120)}, ok`;
    const folded = foldIcsLine(`SUMMARY:${escapeIcsText(summary)}`);
    const lines = folded.split("\r\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const [i, line] of lines.entries()) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
      if (i > 0) expect(line.startsWith(" ")).toBe(true);
    }
    expect(folded.replace(/\r\n /g, "")).toBe(`SUMMARY:${escapeIcsText(summary)}`);
  });

  it("a title cannot inject its own property lines", () => {
    const body = buildIcsTimedCalendar(
      [{ uid: "a", summary: "x\r\nLOCATION:evil", start: new Date("2026-10-08T17:00:00Z"), end: new Date("2026-10-08T18:00:00Z") }],
      { calendarName: "PropLane jobs", now: NOW },
    );
    expect(body.split("\r\n").some((l) => l.startsWith("LOCATION:"))).toBe(false);
  });

  it("prints no LOCATION line when an event carries none", () => {
    const body = buildIcsTimedCalendar(
      [{ uid: "a", summary: "x", start: new Date("2026-10-08T17:00:00Z"), end: new Date("2026-10-08T18:00:00Z"), location: null }],
      { calendarName: "PropLane jobs", now: NOW },
    );
    expect(body).not.toContain("LOCATION");
  });
});

describe("vendor feed events", () => {
  it("emits a stable UID and the full address for a hired, scheduled job", () => {
    const event = vendorJobToFeedEvent("wo-1", row());
    expect(event?.uid).toBe("wo-1@proplane.ai");
    expect(event?.summary).toBe("Fix sink");
    expect(event?.location).toBe("123 Main St, Seattle, WA 98101");
    expect(event?.end.getTime() - event!.start.getTime()).toBe(60 * 60_000);
  });

  it("never prints a street address for a job the vendor is not hired on (offer / open bidding)", () => {
    const offer = row({ bucket: "open", vendorId: undefined, vendorName: undefined, vendorAssignedAt: undefined, biddingOpen: true });
    const event = vendorJobToFeedEvent("wo-2", offer);
    expect(event?.location).toBe("Seattle");
    expect(event?.description).toBeNull();
    const body = buildIcsTimedCalendar([event!], { calendarName: "PropLane jobs", now: NOW });
    expect(body).not.toContain("123 Main");
    expect(body).not.toContain("Leaking trap");
  });

  it("skips jobs with no scheduled time, completed jobs and bad dates", () => {
    expect(vendorJobToFeedEvent("a", row({ scheduledAtIso: undefined }))).toBeNull();
    expect(vendorJobToFeedEvent("b", row({ bucket: "completed" }))).toBeNull();
    expect(vendorJobToFeedEvent("c", row({ scheduledAtIso: "not-a-date" }))).toBeNull();
    expect(vendorJobsToFeedEvents([{ id: "d", row_data: null }, { id: "e", row_data: row() }])).toHaveLength(1);
  });
});
