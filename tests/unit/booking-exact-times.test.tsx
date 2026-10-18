// @vitest-environment jsdom
/**
 * bookings-times-1018 / contract A: exact check-in and check-out times — the property settings, the
 * migration, every manager writer, the channel-stay override and the builders that read it all back.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { fakeSupabaseClient, type Row } from "./helpers/fake-supabase-tables";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  config: null as null | Record<string, unknown>,
  owner: "owner-1" as string | null,
  userId: "owner-1" as string | null,
  db: null as unknown,
}));
vi.mock("@/lib/portal-record-api", () => ({
  createJsonRecordRoute: (config: Record<string, unknown>) => {
    mocks.config = config;
    return { GET: vi.fn(), POST: vi.fn() };
  },
}));
vi.mock("@/lib/property-owner.server", () => ({ resolvePropertyOwnerUserId: async () => mocks.owner }));
vi.mock("@/lib/auth/manager-lease-scope", () => ({
  managerCanWriteCalendarForProperty: async () => true,
  managerHasCalendarAccessForProperty: async () => true,
  managerCanWriteCalendarForProperties: async (_db: unknown, _user: string, ids: readonly string[]) => new Set(ids),
}));
vi.mock("@/lib/workspaces/scope.server", () => ({ activeWorkspacePropertyScope: async () => null }));
vi.mock("@/lib/channel-calendar/require-manager.server", () => ({
  requireBookingsManager: async () => (mocks.userId ? { db: mocks.db, userId: mocks.userId } : null),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn() }));

await import("@/app/api/portal-schedule-records/route");

import { GET as stayDetailsGet, PUT as stayDetailsPut } from "@/app/api/portal/channel-calendar/stay-details/route";
import { BookingsEditSheet } from "@/components/portal/bookings-edit-sheet";
import { BookingsStayDetailsDialog } from "@/components/portal/bookings-stay-details-dialog";
import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { stampStayRow, wallTimeOfInstant } from "@/lib/bookings/stay-stamp";
import { stayTimeOptions } from "@/lib/bookings/stay-time-options";
import { DEFAULT_PROPERTY_STAY_TIMES, normalizePropertyStayTimes } from "@/lib/bookings/stay-times";
import { listManagerChannelCalendarBookings } from "@/lib/channel-calendar/bookings.server";
import {
  airbnbBookingEntries,
  roomBlockEntries,
  withResolvedStayTimes,
  type PropertyBookingEntry,
  type RoomDateBlock,
} from "@/lib/channel-calendar/property-bookings";
import { normalizeStayMetaInput } from "@/lib/channel-calendar/stay-meta";
import { normalizeManagerListingSubmissionV1, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { publicListingProjection } from "@/lib/public-listings.server";
import type { MockProperty } from "@/data/types";

type AtomicWrite = (input: Record<string, unknown>) => Promise<Record<string, unknown>>;

afterEach(() => cleanup());

/** Picks a dropdown option by its exact label ("2:00 pm" must not match "12:00 pm"). */
function pickOption(label: string) {
  const option = screen.getAllByRole("option").find((candidate) => (candidate.textContent ?? "").replace(/^✓/, "").trim() === label);
  if (!option) throw new Error(`No option ${label}`);
  fireEvent.click(option);
}

/* ───────────────────────── property settings ───────────────────────── */

describe("listing submission stayTimes", () => {
  const base = { v: 1, rooms: [], bathrooms: [], sharedSpaces: [], bundles: [], quickFacts: [] } as unknown as ManagerListingSubmissionV1;

  it("is absent on an old submission, so old rows stay byte-identical", () => {
    expect("stayTimes" in normalizeManagerListingSubmissionV1(base)).toBe(false);
  });

  it("round-trips through the normalizer, filling anything bad with its default", () => {
    const saved = normalizeManagerListingSubmissionV1({
      ...base,
      stayTimes: { checkInTime: "16:30", checkOutTime: "25:00", cleaningBufferMinutes: 120, earlyCheckInPriceCents: 4000 } as never,
    });
    expect(saved.stayTimes).toEqual({
      ...DEFAULT_PROPERTY_STAY_TIMES,
      checkInTime: "16:30",
      cleaningBufferMinutes: 120,
      earlyCheckInPriceCents: 4000,
    });
    expect(normalizeManagerListingSubmissionV1(saved).stayTimes).toEqual(saved.stayTimes);
  });

  it("shows a guest the standard times and the add-on prices, never the cleaning buffer", () => {
    const sub = normalizeManagerListingSubmissionV1({ ...base, stayTimes: { checkInTime: "16:00", cleaningBufferMinutes: 90 } as never });
    const listing = { id: "p1", title: "House", listingSubmission: sub } as unknown as MockProperty;
    const projected = publicListingProjection(listing).listingSubmission as ManagerListingSubmissionV1;
    expect(projected.stayTimes).toEqual({
      checkInTime: "16:00",
      checkOutTime: "11:00",
      earliestEarlyCheckIn: "12:00",
      latestLateCheckOut: "14:00",
      earlyCheckInPriceCents: 2500,
      lateCheckOutPriceCents: 2500,
    });
    expect(projected.stayTimes).not.toHaveProperty("cleaningBufferMinutes");
  });

  it("offers every half hour, and keeps an off-grid stored time as its own choice", () => {
    expect(stayTimeOptions().length).toBe(48);
    expect(stayTimeOptions("15:00").map((option) => option.value)).not.toContain("15:15");
    expect(stayTimeOptions("15:15").map((option) => option.value)).toContain("15:15");
    expect(stayTimeOptions()[30]).toEqual({ value: "15:00", label: "3:00 pm" });
  });
});

/* ───────────────────────── the migration ───────────────────────── */

describe("migration 20261018220000_booking_exact_times", () => {
  const sql = readFileSync(join(process.cwd(), "supabase/migrations/20261018220000_booking_exact_times.sql"), "utf8");

  it("is additive and idempotent", () => {
    expect(sql).toMatch(/add column if not exists check_in_at timestamptz/);
    expect(sql).toMatch(/add column if not exists check_out_at timestamptz/);
    expect(sql).toMatch(/create or replace function public\.enforce_short_stay_room_date_block/);
    expect(sql).toMatch(/drop trigger if exists enforce_short_stay_room_date_block/);
    expect(sql).not.toMatch(/\bdrop (table|column)\b/i);
    expect(sql).not.toMatch(/\bdelete from\b/i);
  });

  it("keeps every behaviour of the capacity trigger", () => {
    for (const piece of [
      "security definer set search_path = ''",
      "errcode = '23514', message = 'Short-stay dates are invalid.'",
      "errcode = '23514', message = 'Assigned property is unavailable to this owner.'",
      "occupancy_revision = p.occupancy_revision + 1",
      "occupancyCapacity",
      "{stayDetails,guests}",
      "errcode = 'P4001', message = 'Those dates are no longer available.'",
      "'hold', 'confirmed'",
    ]) {
      expect(sql, piece).toContain(piece);
    }
  });

  it("sweeps on exact wall times, from the row, else the property, else 15:00 / 11:00", () => {
    expect(sql).toContain("check_in + public.stay_wall_time(");
    expect(sql).toContain("check_out + public.stay_wall_time(");
    expect(sql).toContain("{stayTimes,checkInTime}");
    expect(sql).toContain("time '15:00'");
    expect(sql).toContain("time '11:00'");
    expect(sql).toContain("timestamp");
  });

  it("backfills only stays without a time, on the Pacific zone, with the trigger paused and restored", () => {
    expect(sql).toContain("'room_date_block', 'cancelled_room_date_block'");
    expect(sql).toMatch(/checkInTime.*is null/s);
    expect(sql).toContain("at time zone 'America/Los_Angeles'");
    expect(sql).toMatch(/disable trigger enforce_short_stay_room_date_block/);
    expect(sql).toMatch(/enable trigger enforce_short_stay_room_date_block/);
    expect(sql.indexOf("disable trigger")).toBeLessThan(sql.indexOf("enable trigger"));
  });
});

/* ───────────────────────── pure stamping ───────────────────────── */

describe("stampStayRow", () => {
  const clock = { times: normalizePropertyStayTimes({ checkInTime: "16:00", checkOutTime: "10:00" }), timeZone: "America/Los_Angeles" };
  const row = { checkIn: "2026-12-01", checkOut: "2026-12-04", stayDetails: { source: "Direct" } };

  it("stamps the property's times and the real instants", () => {
    const out = stampStayRow(row, null, clock);
    expect(out.rowData).toMatchObject({ checkInTime: "16:00", checkOutTime: "10:00" });
    expect(out.startsAt).toBe("2026-12-02T00:00:00.000Z");
    expect(out.endsAt).toBe("2026-12-04T18:00:00.000Z");
    expect(out.rowData).toMatchObject({ startsAt: out.startsAt, endsAt: out.endsAt });
  });

  it("the save's own times win; otherwise the stored row's are kept", () => {
    expect(stampStayRow({ ...row, checkInTime: "12:30" }, null, clock).rowData).toMatchObject({ checkInTime: "12:30", checkOutTime: "10:00" });
    const stored = { checkInTime: "13:00", checkOutTime: "12:00" };
    expect(stampStayRow(row, stored, clock).rowData).toMatchObject({ checkInTime: "13:00", checkOutTime: "12:00" });
  });

  it("folds a legacy sheet time into the stay's own time and stops writing it", () => {
    const out = stampStayRow({ ...row, stayDetails: { earlyCheckIn: "13:30", lateCheckOut: "13:00", linen: "Requested" } }, null, clock);
    expect(out.rowData).toMatchObject({ checkInTime: "13:30", checkOutTime: "13:00" });
    expect(out.rowData.stayDetails).toEqual({ linen: "Requested" });
  });

  it("carries the paid add-ons from the stored row and never takes them from the save", () => {
    const addOns = { early_check_in: { time: "12:00", priceCents: 2500, status: "paid" } };
    const forged = { early_check_in: { time: "09:00", priceCents: 0, status: "paid" } };
    const out = stampStayRow({ ...row, stayDetails: { source: "Direct", addOns: forged } }, { stayDetails: { addOns, estimatedArrival: "14:15" } }, clock);
    expect(out.rowData.stayDetails).toEqual({ source: "Direct", addOns, estimatedArrival: "14:15" });
    expect(stampStayRow({ ...row, stayDetails: { addOns: forged } }, null, clock).rowData.stayDetails).toEqual({});
  });

  it("reads an instant back as wall time", () => {
    expect(wallTimeOfInstant("2026-12-02T00:00:00.000Z", "America/Los_Angeles")).toBe("16:00");
    expect(wallTimeOfInstant("2026-07-01T19:00:00.000Z", "America/Los_Angeles")).toBe("12:00");
    expect(wallTimeOfInstant("nope", "America/Los_Angeles")).toBeNull();
  });
});

/* ───────────────────── the schedule-records route stamps ───────────────────── */

function routeDb(opts: { property?: Record<string, unknown> | null; blocks?: Row[] }) {
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "eq", "neq", "in", "or", "limit"]) builder[m] = () => builder;
  builder.maybeSingle = async () => ({ data: opts.property ?? null, error: null });
  builder.then = (resolve: (v: unknown) => void) => resolve({ data: opts.blocks ?? [], error: null });
  return { from: () => builder };
}

const PROPERTY_ROW = {
  row_data: { zip: "98107" },
  property_data: { listingSubmission: { zip: "98107", rooms: [], stayTimes: { checkInTime: "16:00", checkOutTime: "10:00" } } },
};

function blockRecord(rowData: Record<string, unknown>) {
  return {
    id: "axis_room_block_owner-1_b1",
    record_type: "room_date_block",
    property_id: "p1",
    manager_user_id: "owner-1",
    starts_at: "2026-12-01T00:00:00",
    ends_at: "2026-12-04T00:00:00",
    row_data: { roomId: "r1", checkIn: "2026-12-01", checkOut: "2026-12-04", bookingStatus: "confirmed", reason: "Reserved", residentName: "Alex Guest", ...rowData },
  };
}

const writeRecord = (record: Record<string, unknown>, db: unknown, existing: Record<string, unknown> | null = null) =>
  (mocks.config!.atomicWrite as AtomicWrite)({ db, user: { id: "owner-1", role: "manager" }, record, existing });

describe("the schedule-records route stamps every stay it saves", () => {
  it("stamps the property's times and the real instants on a new stay", async () => {
    const record = blockRecord({});
    expect(await writeRecord(record, routeDb({ property: PROPERTY_ROW }))).toEqual({ handled: false });
    expect(record.row_data).toMatchObject({ checkInTime: "16:00", checkOutTime: "10:00" });
    expect(record.starts_at).toBe("2026-12-02T00:00:00.000Z");
    expect(record.ends_at).toBe("2026-12-04T18:00:00.000Z");
  });

  it("falls back to 3:00 pm / 11:00 am Pacific when the property has no settings", async () => {
    const record = blockRecord({});
    await writeRecord(record, routeDb({ property: null }));
    expect(record.row_data).toMatchObject({ checkInTime: "15:00", checkOutTime: "11:00" });
    expect(record.starts_at).toBe("2026-12-01T23:00:00.000Z");
  });

  it("uses the manager's override and keeps the stored paid add-ons on an edit", async () => {
    const addOns = { late_check_out: { time: "13:00", priceCents: 2500, status: "paid" } };
    const existing = { ...blockRecord({ checkInTime: "12:00", stayDetails: { addOns, estimatedArrival: "13:45" } }) };
    const record = blockRecord({ checkInTime: "14:00", stayDetails: { source: "Direct", addOns: { late_check_out: { time: "23:00", priceCents: 1, status: "paid" } } } });
    await writeRecord(record, routeDb({ property: PROPERTY_ROW }), existing);
    expect(record.row_data).toMatchObject({ checkInTime: "14:00", checkOutTime: "10:00" });
    expect((record.row_data as Record<string, unknown>).stayDetails).toEqual({ source: "Direct", addOns, estimatedArrival: "13:45" });
  });

  it("a save that names no times keeps the stored row's times", async () => {
    const existing = blockRecord({ checkInTime: "12:00", checkOutTime: "13:00" });
    const record = blockRecord({});
    await writeRecord(record, routeDb({ property: PROPERTY_ROW }), existing);
    expect(record.row_data).toMatchObject({ checkInTime: "12:00", checkOutTime: "13:00" });
    expect(record.ends_at).toBe("2026-12-04T21:00:00.000Z");
  });

  it("a cancelled stay keeps its times too", async () => {
    const existing = blockRecord({ checkInTime: "12:00", checkOutTime: "13:00" });
    const record = { ...blockRecord({}), record_type: "cancelled_room_date_block" };
    await writeRecord(record, routeDb({ property: PROPERTY_ROW }), existing);
    expect(record.row_data).toMatchObject({ checkInTime: "12:00", checkOutTime: "13:00" });
  });

  it("11:00 out then 3:00 pm in on one day is not a conflict; a 2:00 pm late checkout against noon in is", async () => {
    const earlier = { id: "other", row_data: { roomId: "r1", checkIn: "2026-11-28", checkOut: "2026-12-01", checkOutTime: "11:00" } };
    const ok = blockRecord({ checkInTime: "15:00" });
    expect(await writeRecord(ok, routeDb({ property: PROPERTY_ROW, blocks: [earlier as unknown as Row] }))).toEqual({ handled: false });
    const lateOut = { id: "other", row_data: { roomId: "r1", checkIn: "2026-11-28", checkOut: "2026-12-01", checkOutTime: "14:00" } };
    const clash = blockRecord({ checkInTime: "12:00" });
    const result = await writeRecord(clash, routeDb({ property: PROPERTY_ROW, blocks: [lateOut as unknown as Row] }));
    expect(result).toMatchObject({ handled: true, status: 409 });
  });
});

/* ───────────────────────── the builders ───────────────────────── */

const labels = { propertyLabelForId: () => "House", roomLabelForId: () => "Room 1" };
function block(extra: Partial<RoomDateBlock> = {}): RoomDateBlock {
  return { id: "b1", propertyId: "p1", roomId: "r1", checkIn: "2026-12-01", checkOut: "2026-12-04", reason: "Reserved", residentName: "Alex", createdAt: "", ...extra };
}

describe("booking entries carry their exact times", () => {
  const house = normalizePropertyStayTimes({ checkInTime: "16:00", checkOutTime: "10:00" });

  it("explicit, legacy and default", () => {
    const [explicit] = roomBlockEntries([block({ checkInTime: "13:00", checkOutTime: "12:00" })], { ...labels, stayTimesForProperty: () => house });
    expect(explicit).toMatchObject({ checkInTime: "13:00", checkOutTime: "12:00" });
    const [legacy] = roomBlockEntries([block({ stayDetails: { earlyCheckIn: "12:45" } })], { ...labels, stayTimesForProperty: () => house });
    expect(legacy).toMatchObject({ checkInTime: "12:45", checkOutTime: "10:00" });
    const [property] = roomBlockEntries([block()], { ...labels, stayTimesForProperty: () => house });
    expect(property).toMatchObject({ checkInTime: "16:00", checkOutTime: "10:00" });
    const [standard] = roomBlockEntries([block()], labels);
    expect(standard).toMatchObject({ checkInTime: "15:00", checkOutTime: "11:00" });
  });

  it("mirrors the paid add-ons and the estimated arrival", () => {
    const addOns = { early_check_in: { time: "12:00", priceCents: 2500, status: "paid" as const } };
    const [entry] = roomBlockEntries([block({ stayDetails: { addOns, estimatedArrival: "14:30" } })], labels);
    expect(entry).toMatchObject({ addOns, estimatedArrival: "14:30" });
    expect(roomBlockEntries([block()], labels)[0]).not.toHaveProperty("addOns");
  });

  it("a channel stay reads the manager's override, else the property's defaults", () => {
    const properties = [
      {
        propertyId: "p1",
        propertyLabel: "House",
        rooms: [
          {
            connectionId: "c1", roomId: "r1", roomLabel: "Room 1", provider: "airbnb" as const, label: null, lastSyncedAt: null, lastError: null,
            ranges: [
              { sourceUid: "a", start: "2026-12-01", end: "2026-12-03", summary: "Reserved", checkInTime: "13:00" },
              { sourceUid: "b", start: "2026-12-10", end: "2026-12-11", summary: "Reserved" },
            ],
          },
        ],
      },
    ] as unknown as Parameters<typeof airbnbBookingEntries>[0];
    const [overridden, plain] = airbnbBookingEntries(properties, { stayTimesForProperty: () => house });
    expect(overridden).toMatchObject({ checkInTime: "13:00", checkOutTime: "10:00" });
    expect(plain).toMatchObject({ checkInTime: "16:00", checkOutTime: "10:00" });
    // Without the property's times the entry carries only the override; the hook fills the rest live.
    const [bare, untouched] = airbnbBookingEntries(properties);
    expect(bare).toMatchObject({ checkInTime: "13:00" });
    expect(bare).not.toHaveProperty("checkOutTime");
    expect(untouched).not.toHaveProperty("checkInTime");
    const filled = withResolvedStayTimes([bare!, untouched!], () => house);
    expect(filled[0]).toMatchObject({ checkInTime: "13:00", checkOutTime: "10:00" });
    expect(filled[1]).toMatchObject({ checkInTime: "16:00", checkOutTime: "10:00" });
  });

  it("stay-meta keeps the legacy fields readable and accepts the arrival time", () => {
    const meta = normalizeStayMetaInput({
      kind: "lease", refId: "l1", notes: "",
      stayDetails: { earlyCheckIn: "13:00", lateCheckOut: "12:00", estimatedArrival: "9:5", linen: "Requested" },
    });
    expect(meta?.stayDetails).toEqual({ earlyCheckIn: "13:00", lateCheckOut: "12:00", linen: "Requested" });
    expect(normalizeStayMetaInput({ kind: "lease", refId: "l1", stayDetails: { estimatedArrival: "14:05" } })?.stayDetails).toEqual({ estimatedArrival: "14:05" });
  });
});

/* ───────────────────── the imported channel stay ───────────────────── */

describe("an imported channel stay's time override", () => {
  const RANGE = { id: "uid-1", sourceUid: "uid-1", summary: "Reserved", start: "2026-10-10", end: "2026-10-12", reservationCode: "HMABCDEFGH" };
  const BLOCK = { id: "uid-2", sourceUid: "uid-2", summary: "Airbnb (Not available)", start: "2026-10-20", end: "2026-10-21", hostBlock: true };
  let tables: Record<string, Row[]>;
  beforeEach(() => {
    tables = {
      external_calendar_connections: [
        {
          id: "conn-mine", manager_user_id: "owner-1", property_id: "p1", room_id: "room-1", provider: "airbnb", label: "Room 1",
          import_url: "https://www.airbnb.com/calendar/ical/1.ics?s=x", export_token: "tok", imported_ranges: [RANGE, BLOCK],
          last_synced_at: null, last_error: null, export_last_fetched_at: null,
        },
      ],
      channel_stay_details: [],
      manager_property_records: [{ id: "p1", manager_user_id: "owner-1", ...PROPERTY_ROW }],
    };
    mocks.db = fakeSupabaseClient(tables);
    mocks.userId = "owner-1";
  });
  const put = (body: unknown) =>
    stayDetailsPut(new Request("http://localhost/x", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  const get = () => stayDetailsGet(new Request("http://localhost/x?connectionId=conn-mine&sourceUid=uid-1"));

  it("stores the times as instants on the stay's own dates, and the GET returns both forms", async () => {
    const res = await put({ connectionId: "conn-mine", sourceUid: "uid-1", checkInTime: "13:00", checkOutTime: "12:30" });
    expect(res.status).toBe(200);
    expect(tables.channel_stay_details[0]).toMatchObject({
      check_in_at: "2026-10-10T20:00:00.000Z",
      // The range's end is its last night (Oct 12): the check-out DAY is the 13th.
      check_out_at: "2026-10-13T19:30:00.000Z",
    });
    expect(await (await get()).json()).toMatchObject({
      checkInAt: "2026-10-10T20:00:00.000Z",
      checkOutAt: "2026-10-13T19:30:00.000Z",
      checkInTime: "13:00",
      checkOutTime: "12:30",
    });
  });

  it("a field left out is untouched; blank clears it; a bad time is refused", async () => {
    await put({ connectionId: "conn-mine", sourceUid: "uid-1", checkInTime: "13:00", checkOutTime: "12:30" });
    await put({ connectionId: "conn-mine", sourceUid: "uid-1", guestName: "Maria" });
    expect(tables.channel_stay_details[0]).toMatchObject({ guest_name: "Maria", check_in_at: "2026-10-10T20:00:00.000Z" });
    await put({ connectionId: "conn-mine", sourceUid: "uid-1", checkInTime: "" });
    expect(tables.channel_stay_details[0]!.check_in_at).toBeNull();
    expect(tables.channel_stay_details[0]!.check_out_at).toBe("2026-10-13T19:30:00.000Z");
    expect((await put({ connectionId: "conn-mine", sourceUid: "uid-1", checkOutTime: "noon" })).status).toBe(400);
    // Nothing else left on the stay: clearing the last time deletes the row.
    await put({ connectionId: "conn-mine", sourceUid: "uid-1", guestName: "", checkOutTime: null });
    expect(tables.channel_stay_details).toHaveLength(0);
  });

  it("reaches the calendar read as the instants and as the house's wall time", async () => {
    await put({ connectionId: "conn-mine", sourceUid: "uid-1", checkInTime: "13:00" });
    const properties = await listManagerChannelCalendarBookings(mocks.db as never, "owner-1", ["p1"]);
    const range = properties[0]!.rooms[0]!.ranges.find((candidate) => candidate.sourceUid === "uid-1")!;
    expect(range).toMatchObject({ checkInAt: "2026-10-10T20:00:00.000Z", checkInTime: "13:00" });
    expect(range).not.toHaveProperty("checkOutTime");
  });

  it("the dialog shows Check-in and Check-out on a stay, not on a host block, and sends only a changed time", async () => {
    const save = vi.fn(async () => {});
    const entry = {
      source: "airbnb", propertyId: "p1", propertyLabel: "House", roomId: "room-1", roomLabel: "Room 1", summary: "Reserved",
      start: "2026-10-10", end: "2026-10-12", connectionId: "conn-mine", sourceUid: "uid-1", checkInTime: "13:00", checkOutTime: "11:00",
    } as PropertyBookingEntry;
    const view = render(
      <AppUiProvider>
        <BookingsStayDetailsDialog entry={entry} onClose={() => {}} onSaved={() => {}} save={save} />
      </AppUiProvider>,
    );
    const checkIn = document.querySelector('[data-attr="booking-stay-check-in-time"]') as HTMLElement;
    expect(checkIn.textContent).toContain("1:00 pm");
    expect((document.querySelector('[data-attr="booking-stay-check-out-time"]') as HTMLElement).textContent).toContain("11:00 am");
    fireEvent.click(checkIn);
    pickOption("2:00 pm");
    fireEvent.click(document.querySelector('[data-attr="booking-stay-details-save"]') as HTMLElement);
    await vi.waitFor(() => expect(save).toHaveBeenCalled());
    const sent = (save.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(sent.checkInTime).toBe("14:00");
    expect(sent).not.toHaveProperty("checkOutTime");
    view.unmount();

    const hostBlock = { ...entry, summary: "Airbnb (Not available)" } as PropertyBookingEntry;
    render(
      <AppUiProvider>
        <BookingsStayDetailsDialog entry={hostBlock} onClose={() => {}} onSaved={() => {}} save={save} />
      </AppUiProvider>,
    );
    expect(document.querySelector('[data-attr="booking-stay-check-in-time"]')).toBeNull();
  });
});

/* ───────────────────────── the Edit sheet ───────────────────────── */

describe("the Edit sheet", () => {
  const entry: PropertyBookingEntry = {
    source: "block", propertyId: "house", propertyLabel: "House", roomId: "", roomLabel: "", summary: "Guest", residentName: "Guest",
    residentEmail: "guest@example.test", blockId: "block-1", start: "2099-01-01", end: "2099-01-05", bookingStatus: "confirmed",
    stayDetails: { source: "Direct", linen: "Requested" },
  };

  function renderSheet(value: PropertyBookingEntry, onSave = vi.fn(async () => {})) {
    render(
      <AppUiProvider>
        <BookingsEditSheet entry={value} entries={[value]} onClose={() => {}} onSave={onSave} />
      </AppUiProvider>,
    );
    return onSave;
  }
  const trigger = (name: string) => document.querySelector(`[data-attr="${name}"]`) as HTMLElement;

  it("replaces the Early / Late inputs with Check-in and Check-out dropdowns on the property defaults", () => {
    renderSheet(entry);
    expect(screen.queryByText("Early check-in")).toBeNull();
    expect(screen.queryByText("Late check-out")).toBeNull();
    expect(trigger("select-booking-edit-check-in").textContent).toContain("3:00 pm");
    expect(trigger("select-booking-edit-check-out").textContent).toContain("11:00 am");
    expect(document.querySelectorAll('input[type="time"]')).toHaveLength(0);
  });

  it("shows the stay's own times when editing, and saves a changed one as an explicit time", async () => {
    const onSave = renderSheet({ ...entry, checkInTime: "12:30", checkOutTime: "13:00" });
    expect(trigger("select-booking-edit-check-in").textContent).toContain("12:30 pm");
    expect(trigger("select-booking-edit-check-out").textContent).toContain("1:00 pm");
    fireEvent.click(trigger("select-booking-edit-check-out"));
    pickOption("2:00 pm");
    fireEvent.click(screen.getByRole("button", { name: /^save/i }));
    await vi.waitFor(() => expect(onSave).toHaveBeenCalled());
    expect((onSave.mock.calls[0] as unknown[])[0]).toMatchObject({ checkInTime: "12:30", checkOutTime: "14:00" });
    // The legacy fields are no longer written by the sheet.
    expect(JSON.stringify((onSave.mock.calls[0] as unknown[])[0])).not.toContain("earlyCheckIn");
  });
});
