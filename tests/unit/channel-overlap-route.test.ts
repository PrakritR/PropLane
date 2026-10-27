import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type Row } from "../helpers/fake-table-db";

// The schedule-records route refuses a stay that lands on nights a channel holds (docs/agents/bookings.md
// § One booking system). These drive the route's own atomicWrite against seeded rows.
const mocks = vi.hoisted(() => ({ config: null as null | Record<string, unknown> }));
vi.mock("@/lib/portal-record-api", () => ({
  createJsonRecordRoute: (config: Record<string, unknown>) => {
    mocks.config = config;
    return { GET: vi.fn(), POST: vi.fn() };
  },
}));
vi.mock("@/lib/property-owner.server", () => ({ resolvePropertyOwnerUserId: async () => "owner-1" }));
vi.mock("@/lib/auth/manager-lease-scope", () => ({ managerCanWriteCalendarForProperty: async () => true }));
await import("@/app/api/portal-schedule-records/route");

type AtomicWrite = (input: Record<string, unknown>) => Promise<Record<string, unknown>>;

const PROPERTY: Row = {
  id: "p1",
  manager_user_id: "owner-1",
  property_data: { listingSubmission: { rooms: [{ id: "r7", name: "Room 7" }, { id: "r8", name: "Room 8" }], zip: "98105" } },
  row_data: {},
};

function connection(over: Partial<Row> & { id: string; room_id: string; imported_ranges: unknown[] }): Row {
  return { manager_user_id: "owner-1", property_id: "p1", provider: "airbnb", label: null, import_url: "https://www.airbnb.com/calendar/ical/1.ics?s=x", export_token: `tok-${over.id}`, ...over };
}

const ELIAS = { id: "u-elias", sourceUid: "u-elias", summary: "Reserved", start: "2026-10-29", end: "2026-10-31", reservationCode: "HMELIAS001" };

function seed(extra: Record<string, Row[]> = {}) {
  return createFakeDb({
    manager_property_records: [PROPERTY],
    external_calendar_connections: [connection({ id: "c8", room_id: "r8", imported_ranges: [ELIAS] })],
    channel_stay_details: [{ connection_id: "c8", source_uid: "u-elias", guest_name: "Elias Mejia" }],
    portal_schedule_records: [],
    ...extra,
  });
}

function stay(over: Record<string, unknown> = {}): Record<string, unknown> {
  const { row_data, ...rest } = over;
  return {
    id: "b1",
    record_type: "room_date_block",
    property_id: "p1",
    manager_user_id: "owner-1",
    row_data: { roomId: "r8", checkIn: "2026-10-29", checkOut: "2026-11-04", bookingStatus: "confirmed", reason: "", residentName: "Alex Guest", ...((row_data as object) ?? {}) },
    ...rest,
  };
}

const write = (db: ReturnType<typeof seed>, record: Record<string, unknown>, existing: Record<string, unknown> | null = null) =>
  (mocks.config!.atomicWrite as AtomicWrite)({ db, user: { id: "owner-1", role: "manager" }, record, existing });

const detailsOf = (record: Record<string, unknown>) => (record.row_data as { stayDetails?: { channelLink?: unknown } }).stayDetails;

describe("the server refuses a stay that overlaps a channel reservation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("409 names the room, the dates, the channel and the guest", async () => {
    const result = await write(seed(), stay());
    expect(result).toEqual({
      handled: true,
      status: 409,
      error: "Room 8 is booked Oct 29 – Nov 1 on Airbnb (Elias Mejia). Pick other dates or another room.",
    });
  });

  it("falls back to the reservation code when no name is on the stay", async () => {
    const db = seed({ channel_stay_details: [] });
    expect(await write(db, stay())).toMatchObject({ status: 409, error: expect.stringContaining("(HMELIAS001)") });
  });

  it("another room, or the day the guest checks out, is free", async () => {
    expect(await write(seed(), stay({ row_data: { roomId: "r7" } }))).toEqual({ handled: false });
    expect(await write(seed(), stay({ row_data: { checkIn: "2026-11-01", checkOut: "2026-11-04" } }))).toEqual({ handled: false });
    expect(await write(seed(), stay({ row_data: { checkIn: "2026-10-20", checkOut: "2026-10-29" } }))).toEqual({ handled: false });
  });

  it("a whole-home stay clashes with any room's reservation", async () => {
    expect(await write(seed(), stay({ row_data: { roomId: "" } }))).toMatchObject({ status: 409 });
  });

  it("a stay linked to that reservation is the reservation: saved, and the link is stored", async () => {
    const record = stay({ row_data: { stayDetails: { source: "Airbnb", channelLink: { provider: "airbnb", reservationCode: "HMELIAS001" } } } });
    expect(await write(seed(), record)).toEqual({ handled: false });
    expect(detailsOf(record)?.channelLink).toEqual({ provider: "airbnb", reservationCode: "HMELIAS001" });
  });

  it("a linked stay still clashes with a DIFFERENT reservation it grows into", async () => {
    const other = { id: "u-next", sourceUid: "u-next", summary: "Reserved", start: "2026-11-02", end: "2026-11-04", reservationCode: "HMNEXT0001" };
    const db = seed({ external_calendar_connections: [connection({ id: "c8", room_id: "r8", imported_ranges: [ELIAS, other] })] });
    const record = stay({ row_data: { checkOut: "2026-11-05", stayDetails: { channelLink: { provider: "airbnb", reservationCode: "HMELIAS001" } } } });
    expect(await write(db, record)).toMatchObject({ status: 409, error: expect.stringContaining("Nov 2 – Nov 5") });
  });

  it("a typed link no reservation answers to exempts nothing, and is dropped from what is saved", async () => {
    const bogus = { provider: "airbnb", reservationCode: "HMNOPE0000" };
    expect(await write(seed(), stay({ row_data: { stayDetails: { channelLink: bogus } } }))).toMatchObject({ status: 409 });
    const free = stay({ row_data: { roomId: "r7", stayDetails: { source: "Airbnb", channelLink: bogus } } });
    expect(await write(seed(), free)).toEqual({ handled: false });
    expect(detailsOf(free)).toEqual({ source: "Airbnb" });
  });

  it("a link already stored survives a save even when its reservation has left the feed", async () => {
    const gone = { provider: "airbnb", reservationCode: "HMGONE0000" };
    const stored = stay({ row_data: { roomId: "r7", stayDetails: { channelLink: gone } } });
    const record = stay({ row_data: { roomId: "r7", stayDetails: { channelLink: gone } } });
    expect(await write(seed(), record, stored)).toEqual({ handled: false });
    expect(detailsOf(record)?.channelLink).toEqual(gone);
  });

  it("auto-links on the manager's save: the HM code in the notes", async () => {
    const record = stay({ row_data: { reason: "Airbnb HMELIAS001", checkIn: "2026-10-28", checkOut: "2026-11-05" } });
    expect(await write(seed(), record)).toEqual({ handled: false });
    expect(detailsOf(record)?.channelLink).toMatchObject({ provider: "airbnb", reservationCode: "HMELIAS001" });
  });

  it("auto-links on the manager's save: same room, dates within a night", async () => {
    const record = stay({ row_data: { checkIn: "2026-10-30", checkOut: "2026-11-02" } });
    expect(await write(seed(), record)).toEqual({ handled: false });
    expect(detailsOf(record)?.channelLink).toMatchObject({ provider: "airbnb", sourceUid: "u-elias" });
  });

  it("a closed room (no guest) is never auto-linked and still clashes", async () => {
    const record = stay({ row_data: { residentName: "", blockKind: "closed", reason: "Painting", checkIn: "2026-10-29", checkOut: "2026-11-01" } });
    expect(await write(seed(), record)).toMatchObject({ status: 409 });
  });

  it.each(["vrbo", "ical"])("a %s reservation on the same dates is never derived into a link and still clashes", async (provider) => {
    const db = seed({
      external_calendar_connections: [connection({ id: "cv", room_id: "r8", provider, imported_ranges: [ELIAS] })],
      channel_stay_details: [],
    });
    const record = stay({ row_data: { checkIn: "2026-10-30", checkOut: "2026-11-02" } });
    expect(await write(db, record)).toMatchObject({ status: 409 });
    expect(detailsOf(record)?.channelLink).toBeUndefined();
  });

  it("a closure on an Airbnb reservation's nights is never auto-linked and still clashes", async () => {
    const closure = stay({ row_data: { residentName: "", blockKind: "closed", reason: "Painting", checkIn: "2026-10-29", checkOut: "2026-10-31" } });
    expect(await write(seed(), closure)).toMatchObject({ status: 409 });
    expect(detailsOf(closure)?.channelLink).toBeUndefined();
  });

  it("a removed (tombstoned) reservation is not a clash", async () => {
    const tombstone = {
      id: "tomb-1",
      record_type: "channel_stay_tombstone",
      property_id: "p1",
      row_data: { propertyId: "p1", roomId: "r8", provider: "airbnb", sourceUid: "u-elias", range: ELIAS, removedAt: "2026-10-20T00:00:00Z" },
    };
    expect(await write(seed({ portal_schedule_records: [tombstone] }), stay())).toEqual({ handled: false });
  });

  it("a cancelled save and a channel import are never checked", async () => {
    expect(await write(seed(), stay({ row_data: { bookingStatus: "cancelled" } }))).toEqual({ handled: false });
    expect(await write(seed(), stay({ row_data: { reason: "Airbnb", residentName: "Reserved" } }))).toEqual({ handled: false });
  });

  it("names Booking.com when that channel holds the room", async () => {
    const db = seed({
      external_calendar_connections: [
        connection({ id: "cb", room_id: "r8", provider: "booking_com", imported_ranges: [{ id: "bk1", sourceUid: "bk1", summary: "CLOSED - Not available", start: "2026-10-30", end: "2026-10-31" }] }),
      ],
      channel_stay_details: [],
    });
    expect(await write(db, stay())).toMatchObject({ status: 409, error: expect.stringContaining("on Booking.com") });
  });
});

describe("a channel's own closure refuses, PropLane's echoed export does not", () => {
  const HOST = { id: "host", sourceUid: "host", summary: "Airbnb (Not available)", hostBlock: true };

  it("an Airbnb closure nothing of ours explains is a clash", async () => {
    const db = seed({ external_calendar_connections: [connection({ id: "c8", room_id: "r8", imported_ranges: [{ ...HOST, start: "2026-10-29", end: "2027-10-27" }] })] });
    expect(await write(db, stay())).toMatchObject({ status: 409, error: "Room 8 is closed on Airbnb Oct 29 – Nov 4. Pick other dates or another room." });
  });

  it("the echo of our own stay on the same nights is not", async () => {
    const own = { id: "other", record_type: "room_date_block", property_id: "p1", manager_user_id: "owner-1", row_data: { roomId: "r8", checkIn: "2026-10-20", checkOut: "2026-10-29", bookingStatus: "confirmed", residentName: "Sam" } };
    const db = seed({
      external_calendar_connections: [connection({ id: "c8", room_id: "r8", imported_ranges: [{ ...HOST, start: "2026-10-20", end: "2026-10-28" }] })],
      portal_schedule_records: [own],
    });
    expect(await write(db, stay())).toEqual({ handled: false });
  });

  it("this stay's own stored echo does not block moving it", async () => {
    const stored = { id: "b1", record_type: "room_date_block", property_id: "p1", manager_user_id: "owner-1", row_data: { roomId: "r8", checkIn: "2026-10-29", checkOut: "2026-11-01", bookingStatus: "confirmed", residentName: "Alex Guest" } };
    const db = seed({
      external_calendar_connections: [connection({ id: "c8", room_id: "r8", imported_ranges: [{ ...HOST, start: "2026-10-29", end: "2026-10-31" }] })],
      portal_schedule_records: [stored],
    });
    expect(await write(db, stay({ row_data: { checkIn: "2026-10-30", checkOut: "2026-11-02" } }), stored)).toEqual({ handled: false });
  });
});
