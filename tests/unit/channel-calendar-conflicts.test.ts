import { describe, expect, it } from "vitest";
import { conflictingChannelStays } from "@/lib/channel-calendar/channel-conflicts";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
const stay: PropertyBookingEntry = { source: "airbnb", propertyId: "p", propertyLabel: "House", roomId: "r", roomLabel: "Room", summary: "Guest", start: "2026-10-10", end: "2026-10-12" };
describe("channel room conflicts", () => {
  it("counts each channel reservation once and ignores other channel imports", () => {
    expect(conflictingChannelStays([stay, { ...stay, source: "booking_com" }], "p", "r", "airbnb")).toEqual([]);
    expect(conflictingChannelStays([stay, { ...stay, source: "hold" }, { ...stay, source: "proplane" }], "p", "r", "airbnb")).toEqual([stay]);
  });
  it("excludes cancelled holds, other rooms and checkout changeovers", () => {
    const entries: PropertyBookingEntry[] = [stay, { ...stay, source: "hold", bookingStatus: "cancelled" }, { ...stay, source: "hold", roomId: "other" }, { ...stay, source: "hold", start: "2026-10-13" }];
    expect(conflictingChannelStays(entries, "p", "r", "airbnb")).toEqual([]);
  });
  it("includes a whole-home hold on the room and open-ended leases", () => {
    expect(conflictingChannelStays([stay, { ...stay, source: "hold", roomId: "" }], "p", "r", "airbnb")).toEqual([stay]);
    expect(conflictingChannelStays([stay, { ...stay, source: "proplane", start: "2020-01-01", end: "2021-01-01", openEnded: true }], "p", "r", "airbnb")).toEqual([stay]);
  });
});
