import { beforeEach, describe, expect, it, vi } from "vitest";

// Every booking has a name. One validator (room-block-name-rule) shared by saveRoomDateBlock and the
// schedule-records route; the route also announces a native booking created / cancelled / deleted.
const mocks = vi.hoisted(() => ({
  config: null as null | Record<string, unknown>,
  events: [] as Array<Record<string, unknown>>,
}));
vi.mock("@/lib/portal-record-api", () => ({
  createJsonRecordRoute: (config: Record<string, unknown>) => {
    mocks.config = config;
    return { GET: vi.fn(), POST: vi.fn() };
  },
}));
vi.mock("@/lib/property-owner.server", () => ({ resolvePropertyOwnerUserId: async () => "owner-1" }));
vi.mock("@/lib/auth/manager-lease-scope", () => ({ managerCanWriteCalendarForProperty: async () => true }));
vi.mock("@/lib/channel-booking-events.server", () => ({
  emitNativeBookingEvent: async (_db: unknown, input: Record<string, unknown>) => { mocks.events.push(input); },
}));
await import("@/app/api/portal-schedule-records/route");

import {
  ROOM_BLOCK_NAME_REQUIRED,
  ROOM_BLOCK_REASON_REQUIRED,
  ROOM_BLOCK_REASON_RESERVED,
  roomDateBlockNameError,
} from "@/lib/channel-calendar/room-block-name-rule";
import { saveRoomDateBlock } from "@/lib/channel-calendar/room-date-blocks";

type Config = {
  atomicWrite: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  afterWrite: (input: Record<string, unknown>) => Promise<void>;
  afterDelete: (input: Record<string, unknown>) => Promise<void>;
};
const route = () => mocks.config as unknown as Config;

describe("roomDateBlockNameError", () => {
  it("refuses an empty name unless the room is Closed with a reason", () => {
    expect(roomDateBlockNameError({ residentName: "", reason: "Painting" })).toBe(ROOM_BLOCK_NAME_REQUIRED);
    expect(roomDateBlockNameError({})).toBe(ROOM_BLOCK_NAME_REQUIRED);
    expect(roomDateBlockNameError({ residentName: "   ", reason: "x", blockKind: "other" })).toBe(ROOM_BLOCK_NAME_REQUIRED);
    expect(roomDateBlockNameError({ residentName: "", blockKind: "closed", reason: "Painting" })).toBeNull();
    expect(roomDateBlockNameError({ residentName: "", blockKind: "closed", reason: "Owner use" })).toBeNull();
  });
  it("refuses Closed without a reason, and with an import marker as the reason", () => {
    expect(roomDateBlockNameError({ blockKind: "closed", reason: "" })).toBe(ROOM_BLOCK_REASON_REQUIRED);
    expect(roomDateBlockNameError({ blockKind: "closed", reason: "   " })).toBe(ROOM_BLOCK_REASON_REQUIRED);
    expect(roomDateBlockNameError({ blockKind: "closed" })).toBe(ROOM_BLOCK_REASON_REQUIRED);
    expect(roomDateBlockNameError({ blockKind: "closed", reason: "Airbnb" })).toBe(ROOM_BLOCK_REASON_RESERVED);
    expect(roomDateBlockNameError({ blockKind: "closed", reason: " booking " })).toBe(ROOM_BLOCK_REASON_RESERVED);
    expect(roomDateBlockNameError({ blockKind: "closed", reason: "Booking.com repairs" })).toBeNull();
  });
  it("accepts a named booking whatever the reason is", () => {
    expect(roomDateBlockNameError({ residentName: "Maya Chen", reason: "" })).toBeNull();
    expect(roomDateBlockNameError({ residentName: "Maya Chen", reason: "Airbnb" })).toBeNull();
  });
  it("never refuses a cancelled block", () => {
    expect(roomDateBlockNameError({ bookingStatus: "cancelled", residentName: "", reason: "" })).toBeNull();
    expect(roomDateBlockNameError({ bookingStatus: "cancelled", blockKind: "closed", reason: "Airbnb" })).toBeNull();
  });
});

describe("saveRoomDateBlock", () => {
  const base = { propertyId: "p1", roomId: "r1", checkIn: "2026-10-12", checkOut: "2026-10-14", reason: "" };
  it("refuses a nameless block before any request goes out", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(saveRoomDateBlock("m1", base)).rejects.toThrow(ROOM_BLOCK_NAME_REQUIRED);
    await expect(saveRoomDateBlock("m1", { ...base, blockKind: "closed" })).rejects.toThrow(ROOM_BLOCK_REASON_REQUIRED);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
  it("sends blockKind closed for a closed room, drops it for a named one, and lets a cancel through", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { dispatchEvent: () => true, location: { search: "" } });
    const body = () => JSON.parse((fetchMock.mock.calls.at(-1)![1] as { body: string }).body).row as Record<string, unknown>;
    await saveRoomDateBlock("m1", { ...base, reason: "Painting", blockKind: "closed" });
    expect(body()).toMatchObject({ blockKind: "closed", reason: "Painting" });
    await saveRoomDateBlock("m1", { ...base, residentName: "Maya Chen", blockKind: "closed" });
    expect(body()).not.toHaveProperty("blockKind");
    await saveRoomDateBlock("m1", { ...base, id: "b1", bookingStatus: "cancelled" });
    expect(body()).toMatchObject({ bookingStatus: "cancelled", recordType: "cancelled_room_date_block" });
    vi.unstubAllGlobals();
  });
});

describe("the schedule-records route", () => {
  const block = (rowData: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    id: "b1",
    record_type: "room_date_block",
    property_id: "p1",
    manager_user_id: "owner-1",
    row_data: { propertyId: "p1", roomId: "r1", checkIn: "2099-01-01", checkOut: "2099-01-03", ...rowData },
    ...extra,
  });
  const emptyDb = () => {
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "eq", "neq", "in", "or", "limit"]) builder[m] = () => builder;
    builder.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
    return { from: () => builder };
  };
  const write = (record: Record<string, unknown>, existing: Record<string, unknown> | null = null) =>
    route().atomicWrite({ db: emptyDb(), user: { id: "owner-1", role: "manager" }, record, existing });

  beforeEach(() => { mocks.events = []; });

  it("answers 400 to a room block with no name, and to Closed without a reason", async () => {
    expect(await write(block({ reason: "Painting" }))).toMatchObject({ handled: true, status: 400, error: ROOM_BLOCK_NAME_REQUIRED });
    expect(await write(block({ residentName: "  ", reason: "" }))).toMatchObject({ handled: true, status: 400 });
    expect(await write(block({ blockKind: "closed", reason: "" }))).toMatchObject({ handled: true, status: 400, error: ROOM_BLOCK_REASON_REQUIRED });
    expect(await write(block({ blockKind: "closed", reason: "Airbnb" }))).toMatchObject({ handled: true, status: 400, error: ROOM_BLOCK_REASON_RESERVED });
  });
  it("lets a named booking and a Closed room with a reason through", async () => {
    expect(await write(block({ residentName: "Maya Chen" }))).toEqual({ handled: false });
    expect(await write(block({ blockKind: "closed", reason: "Painting" }))).toEqual({ handled: false });
  });
  it("never refuses a cancellation: a cancelled-status upsert, or the cancelled record type, with no name at all", async () => {
    const live = block({ residentName: "Maya Chen" });
    expect(await write(block({ bookingStatus: "cancelled" }), live)).toEqual({ handled: false });
    expect(await write(block({}, { record_type: "cancelled_room_date_block" }), live)).toEqual({ handled: false });
  });
  it("a delete is never subject to the rule (authorizeDelete does not look at names)", async () => {
    const config = mocks.config as unknown as { authorizeDelete: (input: Record<string, unknown>) => Promise<{ ok: boolean }> };
    const result = await config.authorizeDelete({ db: emptyDb(), user: { id: "owner-1", role: "manager" }, records: [block({})] });
    expect(result.ok).toBe(true);
  });

  it("announces a NEW named booking as created, once; not an edit, a closed room or a channel import", async () => {
    await route().afterWrite({ record: block({ residentName: "Maya Chen" }), user: { id: "owner-1" }, existing: null, db: {} });
    await vi.waitFor(() => expect(mocks.events).toHaveLength(1));
    expect(mocks.events[0]).toMatchObject({ event: "booking_created", blockId: "b1", managerUserId: "owner-1", propertyId: "p1", roomId: "r1", guestName: "Maya Chen", checkIn: "2099-01-01", checkOut: "2099-01-03" });

    mocks.events = [];
    await route().afterWrite({ record: block({ residentName: "Maya Chen" }), user: { id: "owner-1" }, existing: block({ residentName: "Maya Chen" }), db: {} });
    await route().afterWrite({ record: block({ blockKind: "closed", reason: "Painting" }), user: { id: "owner-1" }, existing: null, db: {} });
    await route().afterWrite({ record: block({ residentName: "Guest", reason: "Airbnb" }), user: { id: "owner-1" }, existing: null, db: {} });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.events).toEqual([]);
  });
  it("announces cancelling a live booking (status change) as cancelled, but not re-cancelling a cancelled one", async () => {
    const live = block({ residentName: "Maya Chen", bookingStatus: "confirmed" });
    await route().afterWrite({ record: block({ residentName: "Maya Chen", bookingStatus: "cancelled" }, { record_type: "cancelled_room_date_block" }), user: { id: "owner-1" }, existing: live, db: {} });
    await vi.waitFor(() => expect(mocks.events).toHaveLength(1));
    expect(mocks.events[0]).toMatchObject({ event: "booking_cancelled", blockId: "b1", guestName: "Maya Chen" });

    mocks.events = [];
    const already = block({ residentName: "Maya Chen", bookingStatus: "cancelled" }, { record_type: "cancelled_room_date_block" });
    await route().afterWrite({ record: already, user: { id: "owner-1" }, existing: already, db: {} });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.events).toEqual([]);
  });
  it("announces deleting a live named booking as cancelled; a reservation with nobody attached, or an already-cancelled one, is silent", async () => {
    await route().afterDelete({ records: [block({ residentName: "Maya Chen" }), block({ blockKind: "closed", reason: "Painting" }), block({ residentName: "Maya Chen" }, { record_type: "cancelled_room_date_block", id: "b2" })], user: { id: "owner-1" }, db: {} });
    expect(mocks.events).toHaveLength(1);
    expect(mocks.events[0]).toMatchObject({ event: "booking_cancelled", blockId: "b1", guestName: "Maya Chen" });
  });
});
