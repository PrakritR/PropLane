import { describe, expect, it } from "vitest";

import { isValidAirbnbImportUrl, isValidBookingComImportUrl } from "@/lib/channel-calendar/airbnb-url";
import {
  mergeChannelImportedRanges,
  stripChannelImportedRanges,
} from "@/lib/channel-calendar/connections.server";

describe("isValidAirbnbImportUrl", () => {
  it("accepts Airbnb iCal export URLs", () => {
    expect(
      isValidAirbnbImportUrl(
        "https://www.airbnb.com/calendar/ical/123456789.ics?s=abcdefghijklmnopqrstuvwxyz",
      ),
    ).toBe(true);
  });

  it("rejects non-Airbnb hosts", () => {
    expect(isValidAirbnbImportUrl("https://evil.example/calendar/ical/x.ics")).toBe(false);
  });

  it("rejects http", () => {
    expect(isValidAirbnbImportUrl("http://www.airbnb.com/calendar/ical/x.ics")).toBe(false);
  });
});

describe("isValidBookingComImportUrl", () => {
  it("accepts Booking.com iCal export URLs", () => {
    expect(isValidBookingComImportUrl("https://ical.booking.com/v1/export?t=token")).toBe(true);
  });

  it("rejects non-Booking hosts", () => {
    expect(isValidBookingComImportUrl("https://evil.example/v1/export?t=token")).toBe(false);
  });
});

describe("mergeChannelImportedRanges", () => {
  it("replaces prior imported ranges for the same connection", () => {
    const connectionId = "conn-1";
    const existing = [
      { id: "manual-1", start: "2026-01-01", end: "2026-01-02" },
      { id: `channel-import-${connectionId}-old`, start: "2026-02-01", end: "2026-02-02" },
    ];
    const merged = mergeChannelImportedRanges(existing, connectionId, [
      { id: "new", sourceUid: "uid-new", summary: "Reserved", start: "2026-03-01", end: "2026-03-03" },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]?.id).toBe("manual-1");
    expect(merged[1]?.start).toBe("2026-03-01");
    expect(stripChannelImportedRanges(merged, connectionId)).toEqual([existing[0]]);
  });
});
