import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  channelCalendarProviderLabel,
  channelImportUrlErrorMessage,
  icalLabelKey,
  isValidChannelImportUrl,
  isValidIcalImportUrl,
  normalizeIcalLabel,
  parseChannelCalendarProvider,
} from "@/lib/channel-calendar/airbnb-url";
import { importedRangesForFeed } from "@/lib/channel-calendar/export-feed";
import { looksLikeIcalResponse } from "@/lib/channel-calendar/sync.server";
import { channelStatusLine } from "@/lib/channel-calendar/channel-links";
import { bookingGuestLabel, bookingEntryGuestLabel } from "@/lib/channel-calendar/booking-guest-label";
import { bookingSourceLabel } from "@/lib/channel-calendar/bookings-ui";
import { airbnbBookingEntries } from "@/lib/channel-calendar/property-bookings";
import { renderChannelBookingEvent } from "@/lib/channel-booking-events.server";
import { dayStayDisplayName } from "@/lib/occupancy/snapshot";

describe("Other calendar (ical) import URL validator", () => {
  it("accepts any public https URL ending .ics or containing /ical/ or /calendar/", () => {
    for (const url of [
      "https://www.houfy.com/calendar/export/abc.ics",
      "https://furnishedfinder.com/ical/12345",
      "https://example.org/some/calendar/feed?token=x",
      "https://partner.example.com/feeds/room-9.ICS",
      "https://www.vrbo.com/icalendar/abc123.ics?nonTentative",
    ]) expect(isValidIcalImportUrl(url), url).toBe(true);
    expect(isValidChannelImportUrl("ical", "https://www.houfy.com/calendar/export/abc.ics")).toBe(true);
  });

  it("refuses http, a path that is not a calendar, and credentials in the URL", () => {
    for (const url of [
      "http://www.houfy.com/calendar/export/abc.ics",
      "https://www.houfy.com/rooms/12345",
      "https://www.houfy.com/",
      "https://user:pass@www.houfy.com/feed.ics",
      "ftp://www.houfy.com/feed.ics",
      "not a url",
      "",
    ]) expect(isValidIcalImportUrl(url), url).toBe(false);
  });

  it("refuses localhost and private, loopback, link-local and internal hosts", () => {
    for (const host of [
      "localhost",
      "foo.localhost",
      "127.0.0.1",
      "10.0.0.5",
      "172.16.4.4",
      "192.168.1.20",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "[::1]",
      "[fd00::1]",
      "[fe80::1]",
      "2130706433",
      "0x7f.1",
      "printer.local",
      "db.internal",
      "intranet",
    ]) expect(isValidIcalImportUrl(`https://${host}/feed.ics`), host).toBe(false);
  });

  it("the provider is accepted and the error names what an ical link looks like", () => {
    expect(parseChannelCalendarProvider("ical")).toBe("ical");
    expect(channelImportUrlErrorMessage("ical")).toMatch(/\.ics/);
    // The other providers keep refusing a generic URL: the allowlist is untouched.
    expect(isValidChannelImportUrl("airbnb", "https://www.houfy.com/calendar/export/abc.ics")).toBe(false);
    expect(isValidChannelImportUrl("booking_com", "https://www.houfy.com/calendar/export/abc.ics")).toBe(false);
    expect(isValidChannelImportUrl("vrbo", "https://www.houfy.com/calendar/export/abc.ics")).toBe(false);
  });
});

describe("Other calendar response sniffing", () => {
  it("accepts text/calendar or a body that opens with BEGIN:VCALENDAR, refuses HTML and JSON", () => {
    const ics = "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n";
    expect(looksLikeIcalResponse("text/calendar; charset=utf-8", ics)).toBe(true);
    expect(looksLikeIcalResponse("application/octet-stream", ics)).toBe(true);
    expect(looksLikeIcalResponse(null, `﻿  ${ics}`)).toBe(true);
    expect(looksLikeIcalResponse("text/html", "<html><body>BEGIN:VCALENDAR</body></html>")).toBe(false);
    expect(looksLikeIcalResponse("text/calendar", "<html>login</html>")).toBe(false);
    expect(looksLikeIcalResponse("application/json", '{"events":[]}')).toBe(false);
  });
});

describe("the provider name is read from the row's label", () => {
  it("shows the typed site name, falls back to Other calendar, and ignores a label on other providers", () => {
    expect(channelCalendarProviderLabel("ical", "Houfy")).toBe("Houfy");
    expect(channelCalendarProviderLabel("ical", "  Furnished   Finder ")).toBe("Furnished Finder");
    expect(channelCalendarProviderLabel("ical", "")).toBe("Other calendar");
    expect(channelCalendarProviderLabel("ical")).toBe("Other calendar");
    expect(channelCalendarProviderLabel("airbnb", "Room 3")).toBe("Airbnb");
    expect(channelCalendarProviderLabel("booking_com", "Houfy")).toBe("Booking.com");
    expect(normalizeIcalLabel("x".repeat(80))).toHaveLength(40);
    expect(icalLabelKey(" HOUFY ")).toBe(icalLabelKey("houfy"));
  });

  it("status lines, guest labels, source labels and booking alerts all say the typed name", () => {
    expect(channelStatusLine({ hasImportUrl: true, lastSyncedAt: null }, new Date(), "ical", "Houfy")).toBe("Waiting for Houfy");
    expect(bookingGuestLabel("Reserved", "ical", "Houfy")).toBe("Booked (Houfy)");
    expect(bookingGuestLabel("Houfy (Not available)", "ical", "Houfy")).toBe("Houfy block");
    expect(bookingEntryGuestLabel({ source: "ical", summary: "Reserved", channelLabel: "Houfy" })).toBe("Booked (Houfy)");
    expect(bookingSourceLabel("ical", "Furnished Finder")).toBe("Furnished Finder");
    expect(bookingSourceLabel("ical")).toBe("Other calendar");
    expect(dayStayDisplayName({ source: "ical", summary: "", channelLabel: "Houfy" })).toBe("Booked (Houfy)");
    const alert = renderChannelBookingEvent("channel_booking_created", { provider: "ical", channelLabel: "Houfy", start: "2026-10-20", end: "2026-10-23" });
    expect(alert.subject).toBe("New Houfy booking");
  });

  it("an ical connection draws as a channel stay carrying its site name", () => {
    const entries = airbnbBookingEntries([
      {
        propertyId: "p1",
        propertyLabel: "4709A 8th Ave",
        rooms: [
          {
            connectionId: "c1", roomId: "r8", roomLabel: "Room 8", provider: "ical", label: "Houfy",
            ranges: [{ sourceUid: "u1", start: "2026-10-20", end: "2026-10-23", summary: "Reserved" }],
            lastSyncedAt: null, lastError: null, hasImportUrl: true, importUrl: null, exportUrl: "https://proplane.ai/api/calendar/export/t.ics",
          },
        ],
      },
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ source: "ical", channelLabel: "Houfy", roomId: "r8" });
  });
});

describe("export feed for an Other calendar link", () => {
  const connections = [
    { id: "houfy", roomId: "r8", provider: "ical" as const, importedRanges: [{ id: "a", sourceUid: "a", summary: "Reserved", start: "2026-10-01", end: "2026-10-03" }] },
    { id: "ff", roomId: "r8", provider: "ical" as const, importedRanges: [{ id: "b", sourceUid: "b", summary: "Reserved", start: "2026-11-01", end: "2026-11-03" }] },
    { id: "abb", roomId: "r8", provider: "airbnb" as const, importedRanges: [{ id: "c", sourceUid: "c", summary: "Reserved", start: "2026-12-01", end: "2026-12-03" }] },
  ];

  it("leaves out its own site's stays (no echo) but carries the other site and Airbnb", () => {
    const feed = importedRangesForFeed({ propertyId: "p1", roomId: "r8", destination: "ical", ownConnectionId: "houfy", connections, placements: [] });
    expect(feed).toEqual([
      { start: "2026-11-01", end: "2026-11-03" },
      { start: "2026-12-01", end: "2026-12-03" },
    ]);
  });

  it("an Airbnb link still leaves out all of Airbnb and carries every Other calendar site", () => {
    const feed = importedRangesForFeed({ propertyId: "p1", roomId: "r8", destination: "airbnb", ownConnectionId: "abb", connections, placements: [] });
    expect(feed.map((r) => r.start)).toEqual(["2026-10-01", "2026-11-01"]);
  });

  it("a host block imported from an Other calendar never echoes back", () => {
    const feed = importedRangesForFeed({
      propertyId: "p1", roomId: "r8", destination: "airbnb", connections: [
        { id: "x", roomId: "r8", provider: "ical", importedRanges: [{ id: "h", sourceUid: "h", summary: "Houfy (Not available)", start: "2026-10-10", end: "2026-10-12", hostBlock: true }] },
      ], placements: [],
    });
    expect(feed).toEqual([]);
  });
});

describe("Other calendar migration", () => {
  const sql = readFileSync(resolve("supabase/migrations/20261014010000_channel_calendar_ical_provider.sql"), "utf8");
  it("widens the provider check idempotently without touching rows", () => {
    expect(sql).toContain("drop constraint if exists external_calendar_connections_provider_check");
    expect(sql).toContain("check (provider in ('airbnb', 'booking_com', 'vrbo', 'ical'))");
    expect(sql).not.toMatch(/drop table|delete from|update public/i);
  });
  it("keeps one connection per room and channel, and allows one per site name for ical", () => {
    expect(sql).toContain("drop constraint if exists external_calendar_connections_property_room_provider_unique");
    expect(sql).toMatch(/create unique index if not exists external_calendar_connections_room_channel_unique[\s\S]*\(property_id, room_id, provider\)[\s\S]*where provider <> 'ical'/);
    expect(sql).toMatch(/\(property_id, room_id, provider, lower\(coalesce\(label, ''\)\)\)[\s\S]*where provider = 'ical'/);
  });
});

afterEach(() => vi.unstubAllGlobals());
