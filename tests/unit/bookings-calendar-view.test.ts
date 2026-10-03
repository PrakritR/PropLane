import { describe, expect, it } from "vitest";
import { bookingCheckout, bookingLanes, calendarOccupancy, calendarRange, calendarStatus, occupancyCell } from "@/lib/channel-calendar/bookings-calendar-view";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
const stay = (overrides: Partial<PropertyBookingEntry> = {}): PropertyBookingEntry => ({ source: "proplane", propertyId: "p", propertyLabel: "House", roomId: "r", roomLabel: "Room 1", summary: "Guest", start: "2026-09-28", end: "2026-09-30", ...overrides });
describe("bookings calendar views", () => {
  it("uses Monday weeks and calendar months, including leap years", () => {
    expect(calendarRange("week", "2026-09-30")).toEqual(["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
    expect(calendarRange("month", "2028-02-20")).toHaveLength(29);
    expect(calendarRange("year", "2026-09-30")).toHaveLength(12);
  });
  it("checkout day is free and same-day turnover is not a conflict", () => {
    const outgoing = stay(); const incoming = stay({ start: "2026-10-01", end: "2026-10-03", summary: "Next guest" });
    expect(bookingCheckout(outgoing)).toBe("2026-10-01");
    const cell = occupancyCell([outgoing, incoming], "2026-10-01");
    expect(cell.conflicts).toBe(false); expect(cell.outgoing).toEqual([outgoing]); expect(cell.active).toEqual([incoming]);
    expect(cell.label).toBe("Guest → Next guest");
  });
  it("honors bed capacity while exposing overlapping stays", () => {
    expect(occupancyCell([stay(), stay({ summary: "Second" })], "2026-09-29", 1).conflicts).toBe(true);
    expect(occupancyCell([stay(), stay({ summary: "Second" })], "2026-09-29", 2).conflicts).toBe(false);
    expect(occupancyCell([stay()], "2026-10-02").label).toBe("Vacant");
  });
  it("stacks overlaps but reuses lanes after checkout", () => {
    expect(bookingLanes([stay(), stay({ start: "2026-09-29" }), stay({ start: "2026-10-01", end: "2026-10-02" })]).map(row => row.lane)).toEqual([0, 1, 0]);
  });
  it("excludes holds from heat occupancy without counting overlap twice", () => {
    const capacities = { bedsTotal: () => 1, roomCapacity: () => 1 };
    const days = ["2026-09-29", "2026-09-30", "2026-10-01"];
    expect(calendarOccupancy([stay({ source: "hold" })], days, "p", capacities)).toBe(0);
    expect(calendarOccupancy([stay(), stay()], days, "p", capacities)).toBe(67);
    expect(calendarOccupancy([stay({ source: "block", residentName: "Guest", statusLabel: "Confirmed" })], days, "p", capacities)).toBe(67);
  });
  it("leaves open-ended stays active beyond their loaded horizon", () => {
    const open = stay({ openEnded: true });
    expect(bookingCheckout(open)).toBeNull(); expect(occupancyCell([open], "2027-01-01").active).toHaveLength(1);
  });
  it("status colors reflect dates and preserve channels", () => {
    expect(calendarStatus(stay({ source: "hold" }), "2026-09-29")).toBe("Hold");
    expect(calendarStatus(stay(), "2026-09-29")).toBe("In-house");
    expect(calendarStatus(stay(), "2026-10-01")).toBe("Checked out");
    expect(calendarStatus(stay({ source: "airbnb" }), "2026-09-29")).toBe("Airbnb");
  });
});
