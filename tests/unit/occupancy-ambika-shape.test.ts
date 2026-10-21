/**
 * Sanity check of the resolver against the SHAPE of Ambika's real portfolio on Oct 20 2026: three houses
 * (5257: 9 beds, 5259: 9, 4709A: 10), the long-term roster as imported (`AMBIKA_SEATTLE_RESIDENTS`, real
 * dates), September's Airbnb / Booking.com imports (all checked out by now), the Airbnb stays in the house
 * tonight, one booking typed by hand, and the channel's own "Not available" closures on rooms nobody is in.
 *
 * Expected tonight (captain, production review): 22 / 28 (5257: 8/9, 5259: 8/9, 4709A: 6/10). The old dashboard
 * said 25: it counted the closures as occupied.
 */
import { describe, expect, it } from "vitest";
import {
  AMBIKA_SEATTLE_BOOKINGS,
  AMBIKA_SEATTLE_PROPERTY_IDS,
  AMBIKA_SEATTLE_RESIDENTS,
  type SeattleHouse,
} from "@/lib/ambika-seattle-occupancy";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import { occupancyForDay } from "@/lib/occupancy/snapshot";

const TODAY = "2026-10-20";
const BEDS: Record<SeattleHouse, number> = { "5257": 9, "5259": 9, "4709A": 10 };
const FAR = "2028-10-20";

const capacities = {
  bedsTotal: (propertyId: string) => BEDS[(Object.keys(AMBIKA_SEATTLE_PROPERTY_IDS) as SeattleHouse[]).find((h) => AMBIKA_SEATTLE_PROPERTY_IDS[h] === propertyId)!],
  roomCapacity: () => 1,
};

const base = (house: SeattleHouse, roomNumber: number) => ({
  propertyId: AMBIKA_SEATTLE_PROPERTY_IDS[house],
  propertyLabel: house,
  roomId: `room-${roomNumber}`,
  roomLabel: `Room ${roomNumber}`,
});

function entries(): PropertyBookingEntry[] {
  const out: PropertyBookingEntry[] = [];
  // The long-term roster, as imported.
  for (const r of AMBIKA_SEATTLE_RESIDENTS) {
    out.push({ ...base(r.house, r.roomNumber), source: "proplane", summary: r.name, start: r.start, end: r.end ?? FAR, ...(r.end ? {} : { openEnded: true }) });
  }
  // September's channel imports: every one has checked out by Oct 20.
  for (const b of AMBIKA_SEATTLE_BOOKINGS) {
    out.push({
      ...base(b.house, b.roomNumber),
      source: b.reason === "Booking" ? "booking_com" : "airbnb",
      summary: b.reason,
      start: b.start,
      // `end` is the last night: a stay imported with an exclusive check-out is stored as its last night.
      end: b.end,
    });
  }
  const airbnb = (house: SeattleHouse, room: number, start: string, end: string) =>
    out.push({ ...base(house, room), source: "airbnb", summary: "Reserved", start, end });
  // Airbnb guests in the house tonight (check-out is the day after the last night).
  airbnb("5257", 4, "2026-10-18", "2026-10-21");
  airbnb("5257", 5, "2026-10-19", "2026-10-22");
  airbnb("5257", 6, "2026-10-20", "2026-10-23");
  airbnb("5259", 1, "2026-10-17", "2026-10-24");
  airbnb("4709A", 4, "2026-10-19", "2026-10-21");
  airbnb("4709A", 7, "2026-10-15", "2026-10-26");
  airbnb("4709A", 9, "2026-10-18", "2026-10-22");
  // An Airbnb stay that checked out this morning: its last night was yesterday.
  airbnb("4709A", 8, "2026-10-16", "2026-10-19");
  // A direct booking the manager typed by hand (the Add sheet never sets a status: it reads "Hold").
  out.push({ ...base("5257", 7), source: "block", summary: "Direct guest", residentName: "Direct guest", bookingStatus: "hold", blockId: "b-direct", start: "2026-10-19", end: "2026-10-24" });
  // The channel's own closures on rooms nobody is in: busy on the calendar, not occupied.
  const closure = (house: SeattleHouse, room: number) =>
    out.push({ ...base(house, room), source: "airbnb", summary: "Airbnb (Not available)", start: "2026-10-10", end: "2026-11-15" });
  closure("5257", 2); // Alexander left Sep 30
  closure("5259", 3);
  closure("4709A", 5);
  return out;
}

describe("Ambika's portfolio on Oct 20 2026", () => {
  const all = entries();
  const ids = Object.values(AMBIKA_SEATTLE_PROPERTY_IDS);

  it("22 of 28 beds have a person in them, house by house", () => {
    const by = (house: SeattleHouse) => occupancyForDay(all, TODAY, [AMBIKA_SEATTLE_PROPERTY_IDS[house]], capacities);
    expect([by("5257").inHouse, by("5257").total]).toEqual([8, 9]);
    expect([by("5259").inHouse, by("5259").total]).toEqual([8, 9]);
    expect([by("4709A").inHouse, by("4709A").total]).toEqual([6, 10]);
    const portfolio = occupancyForDay(all, TODAY, ids, capacities);
    expect([portfolio.inHouse, portfolio.total]).toEqual([22, 28]);
  });

  it("the calendar still draws three closed beds as busy, which is what made the old KPI say 25", () => {
    const portfolio = occupancyForDay(all, TODAY, ids, capacities);
    expect(portfolio.occupied).toBe(25);
  });

  it("a stay that checked out this morning and a lease that ended Sep 30 hold nothing tonight", () => {
    // 4709A room 8: last night was yesterday (the Oct 19 stay checked out this morning); 5257 room 2: Alexander left Sep 30.
    const ofRoom = (house: SeattleHouse, room: number) =>
      all.filter((e) => e.propertyId === AMBIKA_SEATTLE_PROPERTY_IDS[house] && e.roomId === `room-${room}` && e.start <= TODAY && e.end >= TODAY && e.summary !== "Airbnb (Not available)");
    expect(ofRoom("4709A", 8)).toEqual([]);
    expect(ofRoom("5257", 2)).toEqual([]);
    // Yesterday the 4709A guest was still in the house: one more person than tonight there.
    const yesterday = occupancyForDay(all, "2026-10-19", [AMBIKA_SEATTLE_PROPERTY_IDS["4709A"]], capacities).inHouse!;
    const tonight = occupancyForDay(all, TODAY, [AMBIKA_SEATTLE_PROPERTY_IDS["4709A"]], capacities).inHouse!;
    expect(yesterday).toBe(tonight + 1); // r8's guest was still here until this morning
  });
});
