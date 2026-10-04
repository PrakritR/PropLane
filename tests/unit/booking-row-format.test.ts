import { describe, expect, it } from "vitest";
import { bookingPlaceLine, formatBookingStayRangeShort } from "@/lib/channel-calendar/bookings-ui";

describe("booking row facts (studio format)", () => {
  const now = new Date(2026, 9, 3);
  // The second argument is the INCLUSIVE last night; the check-out day is derived.
  it("short arrow range, year only outside this year", () => {
    expect(formatBookingStayRangeShort("2026-09-28", "2026-10-05", false, now)).toBe("Sep 28 → Oct 6");
    expect(formatBookingStayRangeShort("2026-10-05", "2027-10-05", false, now)).toBe("Oct 5 → Oct 6, 2027");
    expect(formatBookingStayRangeShort("2026-10-15", "2026-10-16", true, now)).toBe("From Oct 15");
    // A one-night stay still reads as two dates, never collapsed to one.
    expect(formatBookingStayRangeShort("2026-10-05", "2026-10-05", false, now)).toBe("Oct 5 → Oct 6");
  });
  it("property first, then room, never a repeated segment", () => {
    expect(bookingPlaceLine("Alder Row — 3 rooms · 3 rooms", "Room 1")).toBe("Alder Row — 3 rooms · Room 1");
    expect(bookingPlaceLine("Alder House", "Room 2")).toBe("Alder House · Room 2");
    expect(bookingPlaceLine("Cedar Flat 2B", "Unit 2B")).toBe("Cedar Flat 2B · Unit 2B");
  });
});
