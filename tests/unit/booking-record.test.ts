import { describe, expect, it } from "vitest";
import { BOOKING_DETAIL_TABS, parseBookingDetailTab } from "@/lib/portal-detail-routes";
import { recordSections } from "@/lib/portals/record-sections";
import { bookingNights, bookingRateSummary, guestPastStays } from "@/lib/channel-calendar/booking-record";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";

const entry = (over: Partial<PropertyBookingEntry>): PropertyBookingEntry => ({
  source: "airbnb",
  propertyId: "p1",
  propertyLabel: "5400 Ballard Ave NW",
  roomId: "r3",
  roomLabel: "Room 3",
  summary: "Emma Müller",
  start: "2026-10-10",
  end: "2026-10-13",
  ...over,
});

describe("booking record tabs", () => {
  it("the declared tabs are exactly the rendered rail: Booking, Guest, Payments, Communication", () => {
    const rail = recordSections("manager", "booking", { basePath: "/portal" }).groups.flatMap((g) => g.items.map((i) => i.id));
    expect(rail).toEqual([...BOOKING_DETAIL_TABS]);
    expect(BOOKING_DETAIL_TABS).toEqual(["overview", "guest", "payments", "communication"]);
  });

  it("the rail labels read Booking · Guest | Payments | Communication", () => {
    const groups = recordSections("manager", "booking", { basePath: "/portal" }).groups;
    expect(groups.map((g) => [g.label, g.items.map((i) => i.label)])).toEqual([
      ["Booking", ["Booking", "Guest"]],
      ["Linked", ["Payments"]],
      ["", ["Communication"]],
    ]);
  });

  it("old declared tabs land on their nearest section", () => {
    expect(parseBookingDetailTab("charges")).toBe("payments");
    expect(parseBookingDetailTab("documents")).toBe("overview");
    expect(parseBookingDetailTab("activity")).toBe("overview");
    expect(parseBookingDetailTab("guest")).toBe("guest");
    expect(parseBookingDetailTab(undefined)).toBe("overview");
  });

  it("Message leads the header (no check-in details action exists) and Edit follows", () => {
    expect(recordSections("manager", "booking", {}).headerActions.map((a) => a.id)).toEqual(["message", "edit"]);
  });

  it("section hrefs point at the booking route", () => {
    const item = recordSections("manager", "booking", { basePath: "/portal" }).groups[1]!.items[0]!;
    expect(item.href("k 1")).toBe("/portal/bookings/k%201/payments");
  });
});

describe("booking facts", () => {
  it("counts inclusive nights and prices a nightly rate", () => {
    expect(bookingNights(entry({}))).toBe(4);
    expect(bookingRateSummary(entry({ rate: 153, rateBasis: "daily" }))).toEqual({ calc: "4 nights × $153.00", total: "$612.00" });
  });

  it("does not multiply a monthly rate by nights", () => {
    expect(bookingRateSummary(entry({ rate: 1050, rateBasis: "monthly" }))).toEqual({ calc: "4 nights at $1,050.00 per month", total: null });
    expect(bookingRateSummary(entry({}))).toBeNull();
  });

  it("finds the guest's earlier stays by email, then by name", () => {
    const current = entry({});
    const earlier = entry({ start: "2026-05-02", end: "2026-05-05" });
    const other = entry({ summary: "Raj Shah", start: "2026-05-02", end: "2026-05-05" });
    const result = guestPastStays(current, [current, earlier, other], "2026-10-04");
    expect(result.count).toBe(1);
    expect(result.latest).toBe(earlier);
    expect(guestPastStays(current, [current], "2026-10-04")).toEqual({ count: 0, latest: null });
    const byEmail = guestPastStays(entry({ residentEmail: "e@x.com", summary: "E" }), [entry({ residentEmail: "E@x.com", summary: "Emma M.", start: "2026-01-01", end: "2026-01-03" })], "2026-10-04");
    expect(byEmail.count).toBe(1);
  });
});
