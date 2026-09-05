import { describe, expect, it } from "vitest";
import {
  bookingsForListTab,
  bookingsForListBucket,
  classifyBookingListBucket,
  countBookingsByListBucket,
  bookingOccupancyStats,
  formatBookingStayRange,
} from "@/lib/channel-calendar/bookings-ui";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";

const entry = (over: Partial<PropertyBookingEntry>): PropertyBookingEntry => ({
  source: "proplane",
  propertyId: "p1",
  propertyLabel: "Brooklyn House",
  roomId: "r1",
  roomLabel: "Room 2",
  summary: "Riley Group Lead",
  start: "2026-09-14",
  end: "2026-09-30",
  ...over,
});

describe("bookingsForListTab", () => {
  const today = "2026-09-04";
  const rows = [
    entry({ start: "2026-09-04", end: "2026-09-10" }),
    entry({ start: "2026-09-20", end: "2026-09-25", summary: "Later guest" }),
    entry({ start: "2026-08-01", end: "2026-09-05", summary: "Departing" }),
  ];

  it("returns all stays sorted by start", () => {
    expect(bookingsForListTab(rows, "all", today).map((r) => r.summary)).toEqual([
      "Departing",
      "Riley Group Lead",
      "Later guest",
    ]);
  });

  it("filters check-ins within the horizon", () => {
    const checkIns = bookingsForListTab(rows, "check_ins", today);
    expect(checkIns.map((r) => r.summary)).toEqual(["Riley Group Lead"]);
  });

  it("filters check-outs within the horizon", () => {
    const checkOuts = bookingsForListTab(rows, "check_outs", today);
    expect(checkOuts.map((r) => r.summary)).toEqual(["Departing", "Riley Group Lead"]);
  });
});

describe("bookingsForListBucket", () => {
  const today = "2026-09-04";
  const rows = [
    entry({ start: "2026-09-10", end: "2026-09-20", summary: "Upcoming guest" }),
    entry({ start: "2026-09-01", end: "2026-09-15", summary: "In-house guest" }),
    entry({ start: "2026-08-01", end: "2026-08-31", summary: "Past guest" }),
  ];

  it("classifies stays into upcoming, in-house, and past", () => {
    expect(classifyBookingListBucket(rows[0], today)).toBe("upcoming");
    expect(classifyBookingListBucket(rows[1], today)).toBe("inhouse");
    expect(classifyBookingListBucket(rows[2], today)).toBe("past");
  });

  it("filters and counts by bucket", () => {
    expect(bookingsForListBucket(rows, "upcoming", today).map((r) => r.summary)).toEqual([
      "Upcoming guest",
    ]);
    expect(countBookingsByListBucket(rows, today)).toEqual({
      upcoming: 1,
      inhouse: 1,
      past: 1,
    });
  });
});

describe("bookingOccupancyStats", () => {
  it("computes month occupancy from booked nights", () => {
    const rows = [entry({ start: "2026-09-01", end: "2026-09-15" })];
    const stats = bookingOccupancyStats(rows, new Date("2026-09-04T12:00:00"), "month");
    expect(stats.bookedNights).toBeGreaterThan(0);
    expect(stats.occupancyPercent).toBeGreaterThan(0);
  });
});

describe("formatBookingStayRange", () => {
  it("marks open-ended stays", () => {
    expect(formatBookingStayRange("2026-09-01", "2028-09-01", true)).toContain("onward");
  });
});
