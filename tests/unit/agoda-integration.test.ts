import { describe, expect, it } from "vitest";

import { channelStatusLine, AGODA_FEED_STALE_AFTER_MS, isAgodaSite } from "@/lib/channel-calendar/channel-links";
import { agodaRowFact } from "@/lib/channel-calendar/channel-row-fact";
import { isChannelFetcher, shouldStampExportFetch, EXPORT_FETCH_STAMP_THROTTLE_MS } from "@/lib/channel-calendar/export-fetch-stamp";
import { generateIcsCalendar } from "@/lib/ical/generate";

const now = new Date("2026-11-23T20:00:00Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();

describe("Agoda row", () => {
  it("is an Other calendar link named Agoda, any case", () => {
    expect(isAgodaSite("ical", " agoda ")).toBe(true);
    expect(isAgodaSite("ical", "Houfy")).toBe(false);
    expect(isAgodaSite("airbnb", "Agoda")).toBe(false);
  });

  it("status: never fetched, fresh, and not pulling", () => {
    const opts = { staleAfterMs: AGODA_FEED_STALE_AFTER_MS };
    const base = { hasImportUrl: true, lastSyncedAt: hoursAgo(1) };
    expect(channelStatusLine({ ...base, exportLastFetchedAt: null }, now, "ical", "Agoda", opts)).toMatch(/^Agoda has not fetched PropLane yet/);
    expect(channelStatusLine({ ...base, exportLastFetchedAt: hoursAgo(2) }, now, "ical", "Agoda", opts)).toMatch(/^Synced · Agoda /);
    expect(channelStatusLine({ ...base, exportLastFetchedAt: hoursAgo(30) }, now, "ical", "Agoda", opts)).toMatch(/^Not pulling · Agoda /);
    // Without the opt-in the existing wording is unchanged.
    expect(channelStatusLine({ hasImportUrl: true, lastSyncedAt: null }, now, "ical", "Houfy")).toBe("Waiting for Houfy");
  });

  it("row fact counts the rooms Agoda has gone quiet on", () => {
    const rooms = [
      { lastSyncedAt: null, exportLastFetchedAt: hoursAgo(1) },
      { lastSyncedAt: null, exportLastFetchedAt: hoursAgo(40) },
      { lastSyncedAt: null, exportLastFetchedAt: null },
    ];
    expect(agodaRowFact({ rooms, total: 28, now: now.getTime() })).toBe("Connected · 3 of 28 rooms · Agoda last fetched 1 h ago · 2 not pulling");
    expect(agodaRowFact({ rooms: [], total: 28 })).toBe("");
  });
});

describe("export fetch stamp by platform", () => {
  it("recognises each connection's own fetcher by name only", () => {
    expect(isChannelFetcher("Airbnb Calendar", "airbnb")).toBe(true);
    expect(isChannelFetcher("Mozilla/5.0 (Macintosh) AppleWebKit Chrome/120 Safari/537", "ical", "Agoda")).toBe(false);
    expect(isChannelFetcher("Agoda-Calendar-Sync/1.0", "ical", "Agoda")).toBe(true);
    expect(isChannelFetcher("Agoda-Calendar-Sync/1.0", "ical", "Houfy")).toBe(false);
    // Only the two rows that surface a last-fetch state are recognised: a provider whose row shows none is
    // never stamped, so no stored fact exists that nothing reads.
    expect(isChannelFetcher("Booking.com Calendar Sync", "booking_com")).toBe(false);
    expect(isChannelFetcher("Vrbo Calendar", "vrbo")).toBe(false);
  });

  // "Agoda last fetched" is the ONLY input to Synced / Not pulling, so a stranger's fetch must not say Agoda was here:
  // curl, an uptime probe or a link checker leaves the row reading "has not fetched PropLane yet".
  it("no unnamed fetcher counts as the channel", () => {
    for (const ua of ["curl/8.4.0", "Java/17.0.2", "Better Uptime Bot", "", null]) {
      expect(isChannelFetcher(ua, "ical", "Agoda"), String(ua)).toBe(false);
      expect(shouldStampExportFetch({ userAgent: ua, provider: "ical", label: "Agoda", lastFetchedAt: null, now }), String(ua)).toBe(false);
    }
  });

  it("throttles to 15 minutes", () => {
    expect(EXPORT_FETCH_STAMP_THROTTLE_MS).toBe(15 * 60_000);
    expect(shouldStampExportFetch({ userAgent: "Agoda/1.0", provider: "ical", label: "Agoda", lastFetchedAt: hoursAgo(0.1), now })).toBe(false);
    expect(shouldStampExportFetch({ userAgent: "Agoda/1.0", provider: "ical", label: "Agoda", lastFetchedAt: hoursAgo(0.3), now })).toBe(true);
  });
});

describe("feed body", () => {
  it("carries a timezone and refresh hint, CRLF, folded lines", () => {
    const ics = generateIcsCalendar([{ start: "2026-12-01", end: "2026-12-03" }], { calendarName: "PropLane" });
    expect(ics).toContain("X-WR-TIMEZONE:UTC\r\n");
    expect(ics).toContain("REFRESH-INTERVAL;VALUE=DURATION:PT1H\r\n");
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics.split("\r\n").every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
  });
});
