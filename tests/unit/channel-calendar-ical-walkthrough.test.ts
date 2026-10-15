/**
 * One Other-calendar (`ical`) feed, followed from the bytes a site serves to what the manager reads on
 * Bookings and to what PropLane serves back out: parse -> imported ranges -> the calendar's own rows and
 * their labels -> the export feed the OTHER site then reads (which must never echo a stay back to where
 * it came from). Two links on the same room (Houfy and Furnished Finder) are the point of the batch's
 * constraint change, so both are carried here.
 *
 * The fetch itself is not exercised (`channel-calendar-ical-server.test.ts` owns the pinned-host client
 * and the response sniffing); this is the data path behind the Connect popup. Set
 * `ICAL_WALKTHROUGH_TRANSCRIPT=<path>` to write the narrated walkthrough out as evidence.
 */
import { writeFileSync } from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { bookingEntryGuestLabel } from "@/lib/channel-calendar/booking-guest-label";
import { bookingSourceLabel } from "@/lib/channel-calendar/bookings-ui";
import { channelStatusLine } from "@/lib/channel-calendar/channel-links";
import { importedRangesForFeed } from "@/lib/channel-calendar/export-feed";
import { airbnbBookingEntries } from "@/lib/channel-calendar/property-bookings";
import { icalEventsToImportedRanges } from "@/lib/channel-calendar/sync.server";
import { parseIcsCalendar } from "@/lib/ical/parse";

const lines: string[] = [];
const say = (line = "") => lines.push(line);
const show = (label: string, value: unknown) => say(`   ${label.padEnd(30)} ${typeof value === "string" ? value : JSON.stringify(value)}`);

const HOUFY_ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Houfy//EN",
  "BEGIN:VEVENT",
  "UID:houfy-8841@houfy.com",
  "DTSTART;VALUE=DATE:20261020",
  "DTEND;VALUE=DATE:20261023",
  "SUMMARY:Reserved",
  "DESCRIPTION:Reservation URL: https://www.houfy.com/reservations/HMABCD1234\\nPhone Number (Last 4 Digits): 8842",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:houfy-blocked@houfy.com",
  "DTSTART;VALUE=DATE:20261101",
  "DTEND;VALUE=DATE:20261103",
  "SUMMARY:Houfy (Not available)",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const FF_RANGE = { id: "ff-1", sourceUid: "ff-1", summary: "Reserved", start: "2026-12-01", end: "2026-12-04" };

afterAll(() => {
  const out = process.env.ICAL_WALKTHROUGH_TRANSCRIPT?.trim();
  if (!out) return;
  writeFileSync(out, `${lines.join("\n")}\n`, "utf8");
});

describe("an Other calendar feed, end to end", () => {
  const imported = icalEventsToImportedRanges(parseIcsCalendar(HOUFY_ICS));

  it("the site's .ics becomes imported ranges, with a host block marked as one", () => {
    say("PropLane · Bookings › Integrations › Other calendar (iCal), one feed followed through");
    say();
    say('━━ 1 · The manager pastes a Houfy .ics link and names the site "Houfy"');
    for (const line of HOUFY_ICS.split("\r\n").slice(0, 10)) say(`     | ${line}`);
    say("     | …");
    say();
    say("━━ 2 · Parsed into imported ranges (end = the last night; DTEND is exclusive)");
    for (const range of imported) show(range.sourceUid, `${range.start} → ${range.end} · "${range.summary}"${range.hostBlock ? " · host block" : ""}${range.reservationCode ? ` · ${range.reservationCode}` : ""}${range.phoneLast4 ? ` · phone …${range.phoneLast4}` : ""}`);

    expect(imported).toHaveLength(2);
    // `end` is the LAST NIGHT: iCalendar DTEND is exclusive, and the calendar paints nights.
    expect(imported[0]).toMatchObject({ start: "2026-10-20", end: "2026-10-22", phoneLast4: "8842" });
    expect(imported[1]).toMatchObject({ start: "2026-11-01", end: "2026-11-02", hostBlock: true });
    // The guest's description is not stored - only the code and the last four digits survive.
    expect(JSON.stringify(imported)).not.toContain("Reservation URL");
  });

  it("the manager's Bookings calendar names the site, for both links on the same room", () => {
    say();
    say("━━ 3 · What the manager sees on Bookings (two links on ONE room)");
    const room = (label: string, connectionId: string, ranges: unknown[]) => ({
      connectionId, roomId: "r8", roomLabel: "Attic Nook", provider: "ical", label, ranges,
      lastSyncedAt: null, lastError: null, hasImportUrl: true, importUrl: null,
      exportUrl: `https://proplane.ai/api/calendar/export/${connectionId}.ics`,
    });
    const entries = airbnbBookingEntries([
      { propertyId: "p1", propertyLabel: "Cedar Court", rooms: [room("Houfy", "houfy", imported), room("Furnished Finder", "ff", [FF_RANGE])] as never },
    ]);
    for (const entry of entries) {
      show(`${entry.start} → ${entry.end}`, `${entry.roomLabel} · ${bookingEntryGuestLabel(entry)} · source "${bookingSourceLabel(entry.source, entry.channelLabel)}"`);
    }
    show("status line, never synced", channelStatusLine({ hasImportUrl: true, lastSyncedAt: null }, new Date("2026-10-14T20:00:00Z"), "ical", "Houfy"));
    show("status line, no name typed", channelStatusLine({ hasImportUrl: true, lastSyncedAt: null }, new Date("2026-10-14T20:00:00Z"), "ical", ""));

    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => bookingEntryGuestLabel(entry))).toEqual(["Booked (Houfy)", "Houfy block", "Booked (Furnished Finder)"]);
    expect(entries.map((entry) => entry.channelLabel)).toEqual(["Houfy", "Houfy", "Furnished Finder"]);
  });

  it("the feed PropLane serves back carries the other site's stays and never echoes the source's own", () => {
    say();
    say("━━ 4 · The .ics PropLane serves back out (/api/calendar/export/<token>.ics)");
    const connections = [
      { id: "houfy", roomId: "r8", provider: "ical" as const, importedRanges: imported },
      { id: "ff", roomId: "r8", provider: "ical" as const, importedRanges: [FF_RANGE] },
    ];
    const toHoufy = importedRangesForFeed({ propertyId: "p1", roomId: "r8", destination: "ical", ownConnectionId: "houfy", connections, placements: [] });
    const toFf = importedRangesForFeed({ propertyId: "p1", roomId: "r8", destination: "ical", ownConnectionId: "ff", connections, placements: [] });
    show("read by Houfy", toHoufy);
    show("read by Furnished Finder", toFf);
    say();
    say("Houfy's own stay is absent from the feed Houfy reads (no echo), and neither feed carries the host block.");

    expect(toHoufy).toEqual([{ start: "2026-12-01", end: "2026-12-04" }]);
    expect(toFf).toEqual([{ start: "2026-10-20", end: "2026-10-22" }]);
  });
});
