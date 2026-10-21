/**
 * "Occupied" means somebody is in the bed TODAY. One resolver (`occupancyForDay`) feeds the dashboard
 * KPI, the property cards and the Bookings screens; the public listing reads the same entries as bed
 * spans (`occupiedBedSpans`) and has to agree on which rooms are held.
 *
 * Counted today: a long-term resident, a confirmed channel booking (Airbnb, Booking.com, iCal), a
 * confirmed PropLane short stay. Check-out is exclusive (a stay whose last night was yesterday is gone),
 * a future stay is not here yet, a channel host block / manager closure / pending Hold closes a bed
 * (`occupied`) but is nobody's home (`inHouse`).
 */
import { describe, expect, it } from "vitest";
import {
  isPersonOccupant,
  occupancyForDay,
  type OccupancyCapacities,
} from "@/lib/occupancy/snapshot";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import { dashboardOccupancyFromSnapshot } from "@/lib/dashboard-occupancy";
import { isHostBlockSummary } from "@/lib/channel-calendar/host-block";
import { occupiedBedSpans, occupiedBedsOn, type RoomBedSpan } from "@/lib/room-occupancy-rule";
import { roomAvailability, roomUnavailableRanges } from "@/lib/room-availability";

const TODAY = "2026-10-20";
const YESTERDAY = "2026-10-19";
const TOMORROW = "2026-10-21";
const PROPERTY = "home-1";
const ROOMS = ["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8"] as const;

const capacities: OccupancyCapacities = {
  bedsTotal: () => ROOMS.length,
  roomCapacity: () => 1,
};

function entry(over: Partial<PropertyBookingEntry> & Pick<PropertyBookingEntry, "source" | "roomId" | "start" | "end">): PropertyBookingEntry {
  return {
    propertyId: PROPERTY,
    propertyLabel: "5257 Brooklyn Ave",
    roomLabel: over.roomId.toUpperCase(),
    summary: "Guest",
    ...over,
  };
}

const entries: PropertyBookingEntry[] = [
  // r1: a long-term resident whose lease covers today.
  entry({ source: "proplane", roomId: "r1", start: "2026-09-01", end: "2026-12-31", summary: "Grace", leaseId: "l1" }),
  // r2: an Airbnb guest in the house tonight (last night tomorrow).
  entry({ source: "airbnb", roomId: "r2", start: YESTERDAY, end: TOMORROW, summary: "Reserved" }),
  // r3: an Airbnb stay that CHECKED OUT today (last night yesterday): not counted.
  entry({ source: "airbnb", roomId: "r3", start: "2026-10-16", end: YESTERDAY, summary: "Reserved" }),
  // r4: an Airbnb stay that has not started.
  entry({ source: "airbnb", roomId: "r4", start: "2026-10-25", end: "2026-10-28", summary: "Reserved" }),
  // r5: the channel's own host block (nobody there).
  entry({ source: "airbnb", roomId: "r5", start: "2026-10-01", end: "2026-11-30", summary: "Airbnb (Not available)" }),
  // r6: the manager closed the room.
  entry({ source: "block", roomId: "r6", start: "2026-10-01", end: "2026-10-31", summary: "Painting", blockKind: "closed", reason: "Painting" }),
  // r7: a confirmed PropLane short stay.
  entry({ source: "block", roomId: "r7", start: TODAY, end: TOMORROW, summary: "Dana", residentName: "Dana", bookingStatus: "confirmed", blockId: "b1" }),
  // r8: a guest's short-stay request still waiting on the host (Hold): the room is held, nobody is in it.
  entry({ source: "block", roomId: "r8", start: TODAY, end: TOMORROW, summary: "Eli", residentName: "Eli", bookingStatus: "hold", blockId: "b2", stayDetails: { source: "guest_portal" } }),
];

describe("one resolver for who is in the house today", () => {
  const today = occupancyForDay(entries, TODAY, [PROPERTY], capacities);

  it("counts the long-term resident, the Airbnb guest tonight and the confirmed short stay", () => {
    expect(today.inHouse).toBe(3);
  });

  it("does not count a stay that checked out today or one that starts later: those two rooms are simply free", () => {
    expect(today.total).toBe(8);
    expect(today.total - (today.occupied ?? 0)).toBe(2); // r3 (checked out) and r4 (arrives later)
  });

  it("keeps the calendar's busy beds apart from the people: occupied = people + closed/held beds", () => {
    // r1, r2, r7 are people; r5 (host block), r6 (closure) and r8 (Hold) hold a bed with nobody in it.
    expect(today.occupied).toBe(6);
    expect((today.occupied ?? 0) - (today.inHouse ?? 0)).toBe(3);
  });

  it("moves with the day: tomorrow the Airbnb guest and the short stay are still here, a future stay arrives the day it starts", () => {
    expect(occupancyForDay(entries, TOMORROW, [PROPERTY], capacities).inHouse).toBe(3);
    const arrival = occupancyForDay(entries, "2026-10-25", [PROPERTY], capacities);
    expect(arrival.inHouse).toBe(2); // r1 + r4
    // r2 / r7 left (last night tomorrow), so by the 25th only the resident and the arriving guest remain.
  });

  it("the check-out day itself is gone (exclusive)", () => {
    const checkOutDay = "2026-10-22"; // r2 and r7: last night the 21st
    expect(occupancyForDay(entries, checkOutDay, [PROPERTY], capacities).inHouse).toBe(1);
  });

  it("classifies who is a person", () => {
    const by = (over: Partial<PropertyBookingEntry>) =>
      isPersonOccupant({ source: "airbnb", summary: "Reserved", ...over } as PropertyBookingEntry);
    expect(by({})).toBe(true);
    expect(by({ source: "booking_com", summary: "CLOSED - Not available" })).toBe(true); // a privacy-stripped real booking
    expect(by({ summary: "Airbnb (Not available)" })).toBe(false);
    expect(by({ summary: "Blocked" })).toBe(false);
    expect(by({ source: "proplane" })).toBe(true);
    expect(by({ source: "hold" })).toBe(true);
    expect(by({ source: "block", residentName: "Dana", bookingStatus: "confirmed" })).toBe(true);
    // A booking the manager typed by hand reads "Hold" (the Add sheet never sets a status) and is still a stay.
    expect(by({ source: "block", residentName: "Direct guest", bookingStatus: "hold" })).toBe(true);
    expect(by({ source: "block", residentName: "Eli", bookingStatus: "hold", stayDetails: { source: "guest_portal" } })).toBe(false);
    expect(by({ source: "block", blockKind: "closed", residentName: "x", bookingStatus: "confirmed" })).toBe(false);
  });
});

describe("the dashboard reads people, and its total from the same cell", () => {
  const snapshot = {
    days: [
      {
        dayKey: TODAY,
        occupied: 6,
        inHouse: 3,
        total: 8,
        checkIns: 0,
        checkOuts: 0,
        houses: [{ propertyId: PROPERTY, occupied: 6, inHouse: 3, total: 8, checkIns: 0, checkOuts: 0 }],
      },
    ],
  };

  it("KPI and card say 3 of 8, not the 6 beds the calendar draws as busy", () => {
    const live = dashboardOccupancyFromSnapshot(snapshot, TODAY, []);
    expect(live?.occupiedToday).toBe(3);
    expect(live?.bedsToday).toBe(8);
    expect(live?.byProperty.get(PROPERTY)).toBe(3);
    expect(live?.bedsByProperty.get(PROPERTY)).toBe(8);
  });

  it("an older payload without inHouse falls back to occupied rather than reading zero", () => {
    const old = { days: [{ dayKey: TODAY, occupied: 4, total: 8, checkIns: 0, checkOuts: 0, houses: [] }] };
    expect(dashboardOccupancyFromSnapshot(old, TODAY, [])?.occupiedToday).toBe(4);
  });
});

describe("the public listing agrees with the manager on which rooms are held today", () => {
  const spansFor = (roomId: string): RoomBedSpan[] =>
    entries
      .filter((e) => e.roomId === roomId)
      .map((e) => ({
        start: e.start,
        end: e.end,
        count: 1,
        echoable: e.source === "airbnb" && isHostBlockSummary(e.summary),
      }));

  it("a room with an Airbnb guest tonight is not Available now; one that checked out today is", () => {
    expect(roomAvailability({}, occupiedBedSpans(spansFor("r2")), TODAY)).toEqual({ kind: "from", date: "2026-10-22" });
    expect(roomAvailability({}, occupiedBedSpans(spansFor("r3")), TODAY)).toEqual({ kind: "now" });
  });

  it("a future Airbnb block shows red in the calendar from its first night and leaves today open", () => {
    const spans = occupiedBedSpans(spansFor("r4"));
    expect(roomAvailability({}, spans, TODAY)).toEqual({ kind: "now" });
    expect(roomUnavailableRanges({}, spans, TODAY)).toEqual([{ start: "2026-10-25", end: "2026-10-28" }]);
  });

  it("per room, the held beds today match the manager's occupied cell", () => {
    const heldToday = ROOMS.filter((id) => occupiedBedsOn(occupiedBedSpans(spansFor(id)), TODAY) > 0);
    expect(heldToday).toEqual(["r1", "r2", "r5", "r6", "r7", "r8"]);
    expect(heldToday.length).toBe(occupancyForDay(entries, TODAY, [PROPERTY], capacities).occupied);
  });
});
