import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type Row } from "../helpers/fake-table-db";

// The schedule-records route refuses a stay that lands on nights a channel holds (docs/agents/bookings.md
// § One booking system). These drive the route's own atomicWrite against seeded rows.
const mocks = vi.hoisted(() => ({ config: null as null | Record<string, unknown>, canWrite: true }));
vi.mock("@/lib/portal-record-api", () => ({
  createJsonRecordRoute: (config: Record<string, unknown>) => {
    mocks.config = config;
    return { GET: vi.fn(), POST: vi.fn() };
  },
}));
vi.mock("@/lib/property-owner.server", () => ({ resolvePropertyOwnerUserId: async () => "owner-1" }));
vi.mock("@/lib/auth/manager-lease-scope", () => ({ managerCanWriteCalendarForProperty: async () => mocks.canWrite }));
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
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.canWrite = true;
  });

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

describe("the house in the body must be one the caller may write", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.canWrite = true;
  });
  const asCoManager = (db: ReturnType<typeof seed>, record: Record<string, unknown>, existing: Record<string, unknown> | null = null) =>
    (mocks.config!.atomicWrite as AtomicWrite)({ db, user: { id: "co-1", role: "manager" }, record, existing });

  it("a co-manager without Calendar on the house gets 403 and no guest name, code or dates", async () => {
    mocks.canWrite = false;
    const result = await asCoManager(seed(), stay());
    expect(result).toMatchObject({ handled: true, status: 403 });
    const body = JSON.stringify(result);
    expect(body).not.toMatch(/Elias|HMELIAS001|Oct 29|Airbnb/);
  });

  it("the same co-manager with Calendar edit on the house still reads the clash", async () => {
    expect(await asCoManager(seed(), stay())).toMatchObject({ status: 409, error: expect.stringContaining("Elias Mejia") });
  });

  it("the owner gets the 409 with detail", async () => {
    mocks.canWrite = false;
    expect(await write(seed(), stay())).toMatchObject({ status: 409, error: expect.stringContaining("Elias Mejia") });
  });

  it("an update that re-sends a booking onto another house is refused without a Calendar grant there", async () => {
    mocks.canWrite = false;
    const existing = { ...stay({ property_id: "p0", manager_user_id: "co-1" }) };
    const result = await asCoManager(seed(), stay(), existing);
    expect(result).toMatchObject({ handled: true, status: 403 });
    expect(JSON.stringify(result)).not.toMatch(/Elias|HMELIAS001/);
  });

  it("an update that stays on its own house is not re-gated by the move check", async () => {
    mocks.canWrite = false;
    const existing = stay({ manager_user_id: "co-1" });
    expect(await asCoManager(seed(), stay(), existing)).not.toMatchObject({ status: 403, error: expect.stringContaining("block its rooms") });
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

/**
 * EVIDENCE (EVIDENCE_DIR only): the same route, driven as a manager uses it, recorded as a transcript —
 * what is saved, what is refused, and exactly what the person reads when it is refused.
 */
describe("evidence: saving a stay over a channel reservation", () => {
  const lines: string[] = [];
  const show = (what: string, result: Record<string, unknown>) => {
    const answer =
      result.handled === true
        ? `REFUSED ${result.status} — ${String(result.error ?? "(no detail)")}`
        : "SAVED (no clash)";
    lines.push(`${what}\n    -> ${answer}`);
  };

  it("writes the transcript", async () => {
    mocks.canWrite = true;
    lines.push(
      "House 4709A, Room 8 carries an Airbnb reservation: Elias Mejia, HMELIAS001, Oct 29 - Nov 1 (last night Oct 31).",
      "Every line below is POST /api/portal-schedule-records going through the route's own atomic write.",
      "",
    );

    show('owner saves "Alex Guest" into Room 8, Oct 29 - Nov 4', await write(seed(), stay()));
    show('owner saves the same stay into Room 7 instead', await write(seed(), stay({ row_data: { roomId: "r7" } })));
    show('owner moves it to Nov 1 - Nov 4 (the day the guest checks out)', await write(seed(), stay({ row_data: { checkIn: "2026-11-01", checkOut: "2026-11-04" } })));
    show('owner saves it with no guest name on the reservation (code only)', await write(seed({ channel_stay_details: [] }), stay()));

    const linked = stay({ row_data: { stayDetails: { source: "Airbnb", channelLink: { provider: "airbnb", reservationCode: "HMELIAS001" } } } });
    show('owner links the stay to HMELIAS001 — "this stay IS that reservation"', await write(seed(), linked));
    lines.push(`    stored link: ${JSON.stringify(detailsOf(linked)?.channelLink)}`);

    const other = { id: "u-next", sourceUid: "u-next", summary: "Reserved", start: "2026-11-02", end: "2026-11-04", reservationCode: "HMNEXT0001" };
    const grown = stay({ row_data: { checkOut: "2026-11-05", stayDetails: { channelLink: { provider: "airbnb", reservationCode: "HMELIAS001" } } } });
    show(
      'owner stretches that linked stay to Nov 5, over a DIFFERENT reservation (HMNEXT0001)',
      await write(seed({ external_calendar_connections: [connection({ id: "c8", room_id: "r8", imported_ranges: [ELIAS, other] })] }), grown),
    );

    const bookingCom = seed({
      external_calendar_connections: [
        connection({ id: "cb", room_id: "r8", provider: "booking_com", imported_ranges: [{ id: "bk1", sourceUid: "bk1", summary: "CLOSED - Not available", start: "2026-10-30", end: "2026-10-31" }] }),
      ],
      channel_stay_details: [],
    });
    show("owner saves over nights Booking.com holds instead", await write(bookingCom, stay()));

    mocks.canWrite = false;
    const asCoManager = (record: Record<string, unknown>) =>
      (mocks.config!.atomicWrite as AtomicWrite)({ db: seed(), user: { id: "co-1", role: "manager" }, record, existing: null });
    const refused = await asCoManager(stay());
    show("a co-manager with NO Calendar grant on this house tries the same save", refused);
    lines.push(`    the refusal discloses no guest, code or dates: ${JSON.stringify(refused)}`);
    expect(JSON.stringify(refused)).not.toMatch(/Elias|HMELIAS001|Oct 29|Airbnb/);

    const out = process.env.EVIDENCE_DIR ?? "";
    if (out) {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(out, { recursive: true });
      const title = "Server refuses a stay that lands on nights a channel holds (and gates it on Calendar write)";
      writeFileSync(`${out}/51-channel-overlap-refusal.txt`, `${title}\n${"=".repeat(title.length)}\n\n${lines.join("\n")}\n`, "utf8");
    }
  });
});
