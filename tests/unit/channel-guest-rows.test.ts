/**
 * Channel guests in the manager's Residents list: one row per current or upcoming confirmed channel
 * booking, derived from the booking rows (no login, no application), named with the guest or
 * "<Channel> guest", opening the booking record. Past stays, host blocks, cancelled stays and
 * reservations a placeholder resident already stands in for never get a second row.
 */
import { describe, expect, it } from "vitest";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import { channelGuestName, channelGuestRows, channelStayCoverageKey } from "@/lib/channel-calendar/channel-guest-rows";
import { bookingRecordHref } from "@/lib/portal-detail-routes";
import { bookingEntryKey } from "@/lib/channel-calendar/bookings-ui";

const TODAY = "2026-10-20";

function stay(over: Partial<PropertyBookingEntry>): PropertyBookingEntry {
  return {
    source: "airbnb",
    propertyId: "home-1",
    propertyLabel: "5259 Brooklyn Ave",
    roomId: "r2",
    roomLabel: "Room 2",
    summary: "Reserved",
    start: "2026-10-19",
    end: "2026-10-22",
    connectionId: "c1",
    sourceUid: "uid-1",
    ...over,
  };
}

const opts = { today: TODAY, basePath: "/manager" };

describe("channelGuestRows", () => {
  it("one row per current or upcoming confirmed booking, with house, room, dates and source", () => {
    const rows = channelGuestRows(
      [
        stay({ sourceUid: "uid-now" }),
        stay({ sourceUid: "uid-later", start: "2026-11-02", end: "2026-11-05", roomId: "r3", roomLabel: "Room 3", source: "booking_com" }),
      ],
      opts,
    );
    expect(rows.map((r) => [r.roomLabel, r.channelStay.sourceLabel, r.channelStay.start, r.channelStay.checkOut])).toEqual([
      ["Room 2", "Airbnb", "2026-10-19", "2026-10-23"],
      ["Room 3", "Booking.com", "2026-11-02", "2026-11-06"],
    ]);
    expect(rows[0]!.propertyLabel).toBe("5259 Brooklyn Ave");
    expect(rows[0]!.email).toBe("");
  });

  it("is named with the typed guest name, else '<Channel> guest', never 'Reserved'", () => {
    expect(channelGuestName(stay({ guestName: "Maya Chen" }))).toBe("Maya Chen");
    expect(channelGuestName(stay({}))).toBe("Airbnb guest");
    expect(channelGuestName(stay({ source: "booking_com", summary: "CLOSED - Not available" }))).toBe("Booking.com guest");
    expect(channelGuestName(stay({ source: "vrbo", summary: "" }))).toBe("Vrbo guest");
    // A stay imported into the calendar carries its channel's name as its summary.
    expect(channelGuestName(stay({ summary: "Airbnb" }))).toBe("Airbnb guest");
    expect(channelGuestName(stay({ source: "booking_com", summary: "Booking" }))).toBe("Booking.com guest");
  });

  it("opens the booking record", () => {
    const entry = stay({ guestName: "Maya Chen" });
    const [row] = channelGuestRows([entry], opts);
    expect(row!.channelStay.href).toBe(bookingRecordHref("/manager", bookingEntryKey(entry)));
  });

  it("drops a past stay (checked out today or earlier), a cancelled one and a host block", () => {
    const rows = channelGuestRows(
      [
        stay({ sourceUid: "past", end: "2026-10-19" }), // last night yesterday = checked out today
        stay({ sourceUid: "cancelled", bookingStatus: "cancelled" }),
        stay({ sourceUid: "block", summary: "Airbnb (Not available)" }),
        stay({ sourceUid: "keep" }),
      ],
      opts,
    );
    expect(rows.map((r) => r.id)).toHaveLength(1);
    expect(rows[0]!.name).toBe("Airbnb guest");
  });

  it("a stay on its last night is still here", () => {
    expect(channelGuestRows([stay({ end: TODAY })], opts)).toHaveLength(1);
  });

  it("never repeats a guest a placeholder resident already stands in for", () => {
    const rows = channelGuestRows([stay({})], {
      ...opts,
      coveredByResident: new Set([channelStayCoverageKey("c1", "uid-1")]),
    });
    expect(rows).toHaveLength(0);
  });

  it("never repeats a hand-added resident for the same room and dates", () => {
    const rows = channelGuestRows([stay({})], {
      ...opts,
      residentStayShapes: new Set(["home-1\0r2\x002026-10-19\x002026-10-22"]),
    });
    expect(rows).toHaveLength(0);
  });

  it("only the houses in scope", () => {
    expect(channelGuestRows([stay({})], { ...opts, propertyIds: new Set(["other"]) })).toHaveLength(0);
  });

  it("ignores PropLane's own stays: those are residents, not channel guests", () => {
    expect(channelGuestRows([stay({ source: "proplane" }), stay({ source: "hold" })], opts)).toHaveLength(0);
  });
});
