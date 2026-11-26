import { describe, expect, it } from "vitest";

import { channelStatusLine, AGODA_FEED_STALE_AFTER_MS, isAgodaSite } from "@/lib/channel-calendar/channel-links";
import { agodaRowFact } from "@/lib/channel-calendar/channel-row-fact";
import { isChannelFetcher, shouldStampExportFetch } from "@/lib/channel-calendar/export-fetch-stamp";
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
    // ONE wording for a never-fetched feed, whatever the channel: the threshold only decides "Not pulling".
    expect(channelStatusLine({ hasImportUrl: true, lastSyncedAt: null }, now, "ical", "Houfy")).toBe("Houfy has not fetched PropLane yet");
    expect(channelStatusLine({ hasImportUrl: true, lastSyncedAt: null, exportLastFetchedAt: hoursAgo(30) }, now, "airbnb")).toMatch(/^Synced · Airbnb /);
  });

  // The row and the per-room line answer the same question, so they must keep the same two states apart: a feed
  // Agoda has never read is waiting, not quiet. Oracle: `channelStatusParts`' own wording, pinned in the case above
  // ("Agoda has not fetched PropLane yet" vs "Not pulling"), and docs/agents/integrations.md's truthful status.
  // Wrong behaviour this rejects: the row telling a manager who pasted their links a minute ago that Agoda stopped
  // polling - "Connected · 2 of 28 rooms · 2 not pulling" before Agoda has had any chance to poll.
  it("row fact separates the rooms Agoda has gone quiet on from the ones it has never read", () => {
    const rooms = [
      { lastSyncedAt: null, exportLastFetchedAt: hoursAgo(1) },
      { lastSyncedAt: null, exportLastFetchedAt: hoursAgo(40) },
      { lastSyncedAt: null, exportLastFetchedAt: null },
    ];
    expect(agodaRowFact({ rooms, total: 28, now: now.getTime() })).toBe(
      "Connected · 3 of 28 rooms · Agoda last fetched 1 h ago · 1 not pulling · 1 not fetched yet",
    );

    // Freshly pasted links: nothing has been fetched, so nothing has gone quiet and there is no "last fetched".
    const fresh = [
      { lastSyncedAt: null, exportLastFetchedAt: null },
      { lastSyncedAt: null, exportLastFetchedAt: null },
    ];
    expect(agodaRowFact({ rooms: fresh, total: 28, now: now.getTime() })).toBe(
      "Connected · 2 of 28 rooms · 2 not fetched yet",
    );

    // Every room pulling: no trailing clause at all.
    expect(
      agodaRowFact({ rooms: [{ lastSyncedAt: null, exportLastFetchedAt: hoursAgo(2) }], total: 1, now: now.getTime() }),
    ).toBe("Connected · 1 of 1 room · Agoda last fetched 2 h ago");
    expect(agodaRowFact({ rooms: [], total: 28 })).toBe("");
  });
});

describe("export fetch stamp by platform", () => {
  it("recognises each connection's own fetcher by name only", () => {
    expect(isChannelFetcher("Airbnb Calendar", "airbnb")).toBe(true);
    expect(isChannelFetcher("Mozilla/5.0 (Macintosh) AppleWebKit Chrome/120 Safari/537", "ical", "Agoda")).toBe(false);
    expect(isChannelFetcher("Agoda-Calendar-Sync/1.0", "ical", "Agoda")).toBe(true);
    expect(isChannelFetcher("Agoda-Calendar-Sync/1.0", "ical", "Houfy")).toBe(false);
    expect(isChannelFetcher("Booking.com Calendar Sync", "booking_com")).toBe(true);
    // A channel's own name, not another channel's: the Agoda crawler reading a Booking.com link proves nothing
    // about Booking.com.
    expect(isChannelFetcher("Agoda-Calendar-Sync/1.0", "booking_com")).toBe(false);
    expect(isChannelFetcher("Booking.com Calendar Sync", "airbnb")).toBe(false);
  });

  // `export_last_fetched_at` is the only input to the line the Connect popup draws per room, for whichever channel
  // is selected (`CHANNEL_OPTIONS` holds booking_com). Oracle: docs/agents/integrations.md - the row tells the
  // manager whether the channel has pulled PropLane. Plausible wrong behaviour this rejects: the row still saying
  // Booking.com has not fetched PropLane after Booking.com has fetched the feed.
  it("a Booking.com fetch stamps the row, and the row then reads Synced", () => {
    expect(shouldStampExportFetch({ userAgent: "Booking.com Calendar Sync", provider: "booking_com", lastFetchedAt: null, now })).toBe(true);
    expect(shouldStampExportFetch({ userAgent: "curl/8.4.0", provider: "booking_com", lastFetchedAt: null, now })).toBe(false);

    const unfetched = { hasImportUrl: true, lastSyncedAt: hoursAgo(1), exportLastFetchedAt: null };
    expect(channelStatusLine(unfetched, now, "booking_com")).toContain("Booking.com has not fetched PropLane yet");

    const stamped = { ...unfetched, exportLastFetchedAt: hoursAgo(2) };
    const line = channelStatusLine(stamped, now, "booking_com");
    expect(line.startsWith("Synced")).toBe(true);
    expect(line).toContain("Booking.com");
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
