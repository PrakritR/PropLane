import { beforeEach, describe, expect, it, vi } from "vitest";

import { channelClashText, findChannelClashes, linkedRangeForStay, type ChannelOverlapRange } from "@/lib/channel-calendar/channel-overlap";
import { createFakeDb } from "../helpers/fake-table-db";

const emitted = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/action-events.server", () => ({
  emitActionEvent: vi.fn(async (_db: unknown, input: Record<string, unknown>) => {
    // The bus is idempotent on the event id: a repeat is a no-op, exactly what the real insert does.
    if (!emitted.calls.some((call) => call.eventId === input.eventId)) emitted.calls.push(input);
  }),
}));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));

import { detectChannelClashes } from "@/lib/channel-calendar/channel-overlap.server";
import { emitChannelClashEvent } from "@/lib/channel-booking-events.server";

const P = "p1";
const range = (over: Partial<ChannelOverlapRange> & { connectionId: string; start: string; end: string }): ChannelOverlapRange => ({
  provider: "airbnb",
  propertyId: P,
  roomId: "r8",
  roomLabel: "Room 8",
  summary: "Reserved",
  sourceUid: `uid-${over.connectionId}`,
  ...over,
});

const airbnb = range({ connectionId: "ca", start: "2026-10-29", end: "2026-10-31" });
const booking = range({ connectionId: "cb", provider: "booking_com", start: "2026-10-30", end: "2026-11-02", summary: "CLOSED - Not available" });

describe("linkedRangeForStay only derives onto Airbnb / Booking.com", () => {
  const input = { propertyId: P, roomId: "r8", checkIn: "2026-10-29", checkOut: "2026-11-01", reason: "" };
  it.each(["vrbo", "ical"])("%s with matching dates yields no derived link", (provider) => {
    const resolved = linkedRangeForStay({ ...input, ranges: [range({ connectionId: "cv", provider, start: "2026-10-29", end: "2026-10-31" })] });
    expect(resolved).toMatchObject({ link: undefined, range: undefined, derived: false });
  });
  it("airbnb with matching dates still derives", () => {
    expect(linkedRangeForStay({ ...input, ranges: [airbnb] }).derived).toBe(true);
  });
  it("a Vrbo reservation on a stay's nights is a clash; a closure never derives onto Airbnb", () => {
    const vrbo = range({ connectionId: "cv", provider: "vrbo", start: "2026-10-29", end: "2026-10-31" });
    const nativeStay = { id: "n1", name: "Kumaran", roomId: "r8", checkIn: "2026-10-29", checkOut: "2026-11-01" };
    expect(findChannelClashes({ propertyId: P, ranges: [vrbo], natives: [nativeStay] })).toHaveLength(1);
    const closure = { id: "n2", name: "", reason: "Painting", blockKind: "closed", roomId: "r8", checkIn: "2026-10-29", checkOut: "2026-11-01" };
    expect(findChannelClashes({ propertyId: P, ranges: [airbnb], natives: [closure] })).toHaveLength(1);
  });
});

describe("findChannelClashes", () => {
  it("finds Airbnb and Booking.com holding one room, once, whichever sync asks", () => {
    const fromAirbnbSync = findChannelClashes({ propertyId: P, ranges: [airbnb, booking], natives: [], connectionId: "ca" });
    const fromBookingSync = findChannelClashes({ propertyId: P, ranges: [booking, airbnb], natives: [], connectionId: "cb" });
    expect(fromAirbnbSync).toHaveLength(1);
    expect(fromAirbnbSync[0]).toMatchObject({ start: "2026-10-30", end: "2026-10-31", roomLabel: "Room 8" });
    expect(fromBookingSync[0]!.key).toBe(fromAirbnbSync[0]!.key);
    expect(channelClashText(fromAirbnbSync[0]!)).toBe("Room 8 is double-booked Oct 30 – Nov 1 (Airbnb and Booking.com)");
  });

  it("a sync of an unrelated room reports nothing", () => {
    expect(findChannelClashes({ propertyId: P, ranges: [airbnb, booking], natives: [], connectionId: "other" })).toEqual([]);
  });

  it("different rooms, or back-to-back stays, are not clashes", () => {
    expect(findChannelClashes({ propertyId: P, ranges: [airbnb, { ...booking, roomId: "r7" }], natives: [] })).toEqual([]);
    expect(findChannelClashes({ propertyId: P, ranges: [airbnb, { ...booking, start: "2026-11-01", end: "2026-11-03" }], natives: [] })).toEqual([]);
  });

  it("a host block is a closure, never a side", () => {
    const closed = range({ connectionId: "cb", provider: "booking_com", start: "2026-10-30", end: "2026-11-02", summary: "Not available", hostBlock: true });
    expect(findChannelClashes({ propertyId: P, ranges: [airbnb, closed], natives: [] })).toEqual([]);
  });

  it("a reservation on a PropLane stay is a clash, unless the stay IS that reservation", () => {
    const stay = { id: "b1", name: "Alex", roomId: "r8", checkIn: "2026-10-31", checkOut: "2026-11-04" };
    const clash = findChannelClashes({ propertyId: P, ranges: [airbnb], natives: [stay] });
    expect(clash).toHaveLength(1);
    expect(channelClashText(clash[0]!)).toContain("(Airbnb and PropLane)");
    const linked = { ...stay, link: { provider: "airbnb" as const, sourceUid: "uid-ca" } };
    expect(findChannelClashes({ propertyId: P, ranges: [airbnb], natives: [linked] })).toEqual([]);
    // ...or auto-links to it by dates, within a night.
    expect(findChannelClashes({ propertyId: P, ranges: [airbnb], natives: [{ ...stay, checkIn: "2026-10-29", checkOut: "2026-11-01" }] })).toEqual([]);
  });

  it("a cancelled stay and a clash that is already over are not news", () => {
    expect(findChannelClashes({ propertyId: P, ranges: [airbnb], natives: [{ id: "b1", roomId: "r8", checkIn: "2026-10-30", checkOut: "2026-11-02", cancelled: true }] })).toEqual([]);
    expect(findChannelClashes({ propertyId: P, ranges: [airbnb, booking], natives: [], today: "2026-11-05" })).toEqual([]);
  });
});

describe("one alert per clash", () => {
  beforeEach(() => {
    emitted.calls = [];
  });

  const seed = () =>
    createFakeDb({
      profiles: [{ id: "owner-1", email: "owner@x.test", full_name: "Owner" }],
      manager_property_records: [{ id: P, manager_user_id: "owner-1", property_data: { listingSubmission: { rooms: [{ id: "r8", name: "Room 8" }] } } }],
      external_calendar_connections: [
        { id: "ca", manager_user_id: "owner-1", property_id: P, room_id: "r8", provider: "airbnb", label: null, import_url: "x", export_token: "ta", imported_ranges: [{ id: "u1", sourceUid: "u1", summary: "Reserved", start: "2026-10-29", end: "2026-10-31", reservationCode: "HMAAAA0001" }] },
        { id: "cb", manager_user_id: "owner-1", property_id: P, room_id: "r8", provider: "booking_com", label: null, import_url: "y", export_token: "tb", imported_ranges: [{ id: "u2", sourceUid: "u2", summary: "CLOSED - Not available", start: "2026-10-30", end: "2026-11-02" }] },
      ],
      portal_schedule_records: [],
    });

  it("syncing both rooms, twice, announces the clash once", async () => {
    const db = seed();
    for (const connectionId of ["ca", "cb", "ca"]) {
      const clashes = await detectChannelClashes(db as never, { propertyId: P, connectionId, today: "2026-10-26" });
      for (const clash of clashes) await emitChannelClashEvent(db as never, { clash, managerUserId: "owner-1", propertyLabel: "4709A" });
    }
    expect(emitted.calls).toHaveLength(1);
    expect(emitted.calls[0]).toMatchObject({ domain: "channel_booking", event: "channel_booking_clash", managerUserId: "owner-1" });
    const recipient = (emitted.calls[0]!.recipients as Array<{ rendered: { text: string } }>)[0]!;
    expect(recipient.rendered.text).toContain("Room 8 is double-booked Oct 30 – Nov 1 (Airbnb and Booking.com)");
  });
});
