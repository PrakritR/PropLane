import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import { aggregateRoomOccupancy } from "@/lib/public-room-occupancy";
import { applyMoveInDateToLabel, evaluateRoomRange } from "@/lib/room-availability-range";
import type { AgentContext } from "@/lib/tools/context";
import type { ResidentAgentContext } from "@/lib/tools/resident-context";

const grants = vi.hoisted(() => ({ read: new Set<string>() }));
vi.mock("@/lib/auth/manager-lease-scope", () => ({
  managerHasCalendarAccessForProperty: vi.fn(async (_db: unknown, _user: string, id: string) => grants.read.has(id)),
  managerCanWriteCalendarForProperty: vi.fn(async () => false),
}));
vi.mock("@/lib/occupancy/snapshot.server", () => ({ occupancySnapshotForManager: vi.fn() }));
vi.mock("@/lib/channel-calendar/bookings.server", () => ({ listManagerChannelCalendarBookings: vi.fn() }));

const fake = vi.hoisted(() => ({
  db: null as unknown,
  failApplications: false,
  catalog: [] as Array<Record<string, unknown> & { id: string }>,
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => fake.db }));
vi.mock("@/lib/public-listings.server", () => ({ getPublicListings: async () => fake.catalog }));
// An application id listed in `row_data.executedApplicationId` stands in for a fully executed lease.
vi.mock("@/lib/rental-application/room-public-occupancy-eligibility", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rental-application/room-public-occupancy-eligibility")>()),
  executedApplicationIdsFromLeaseRecords: (rows: Array<{ row_data?: { executedApplicationId?: string } }>) =>
    new Set(rows.flatMap((r) => (r.row_data?.executedApplicationId ? [normalizeApplicationAxisId(r.row_data.executedApplicationId)] : []))),
}));

import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import { roomAvailabilityForRange } from "@/lib/room-availability-range.server";
import {
  agentRegistry,
  leasingSmsAgentRegistry,
  leasingSmsAutonomousTourRegistry,
} from "@/lib/tools";
import { buildResidentRegistry } from "@/lib/tools/resident-index";
import { getListingDetailsTool, checkRoomAvailabilityTool, __resetLeasingCatalogCache, __resetSmsOccupancyCache } from "@/lib/tools/domains/leasing-sms";
import { checkManagerRoomAvailabilityTool } from "@/lib/tools/domains/bookings";
import { residentSmsCheckRoomAvailabilityTool } from "@/lib/tools/domains/resident/sms-listings";
import { API_KEY_PRODUCT_AREAS } from "@/lib/mcp/capabilities";
import { mcpToolCatalog } from "@/lib/mcp/catalog";

const SECRETS = ["Alice Resident", "alice@example.com", "Bob Guest", "HMSECRET99", "Carol Manual", "Dana Block", "Airbnb", "Booking.com"];

function span(start: string, end: string | null, count = 1) {
  return aggregateRoomOccupancy([{ start, end, count }]);
}

describe("evaluateRoomRange (pure)", () => {
  const base = { capacity: 1, moveIn: "2027-01-10", moveOut: "2027-01-20" };

  it("is free with no spans", () => {
    expect(evaluateRoomRange({ ...base, spans: [] })).toEqual({ available: true });
  });

  it("blocks on any overlapping night and reports dates plus the next free window", () => {
    const verdict = evaluateRoomRange({ ...base, spans: span("2027-01-15", "2027-01-31") });
    expect(verdict).toEqual({
      available: false,
      firstConflict: { start: "2027-01-15", end: "2027-01-31" },
      nextAvailableFrom: "2027-02-01",
    });
  });

  it("treats moveOut as exclusive: a stay starting on moveOut does not conflict", () => {
    expect(evaluateRoomRange({ ...base, spans: span("2027-01-20", "2027-02-01") }).available).toBe(true);
  });

  it("shared rooms are free while beds remain, blocked only when every bed is held", () => {
    const one = evaluateRoomRange({ ...base, capacity: 2, spans: span("2027-01-01", null, 1) });
    expect(one.available).toBe(true);
    const full = evaluateRoomRange({ ...base, capacity: 2, spans: aggregateRoomOccupancy([
      { start: "2027-01-01", end: null, count: 1 },
      { start: "2027-01-12", end: "2027-01-14", count: 1 },
    ]) });
    expect(full).toMatchObject({ available: false, firstConflict: { start: "2027-01-12", end: "2027-01-14" } });
  });

  it("a future moveInAvailableDate blocks earlier nights", () => {
    const verdict = evaluateRoomRange({ ...base, spans: [], availableFrom: "2027-01-15" });
    expect(verdict).toEqual({
      available: false,
      firstConflict: { start: "2027-01-10", end: "2027-01-14" },
      nextAvailableFrom: "2027-01-15",
    });
    expect(evaluateRoomRange({ ...base, spans: [], availableFrom: "2027-01-10" }).available).toBe(true);
    expect(evaluateRoomRange({ ...base, spans: [], availableFrom: "1/5/2027" }).available).toBe(true);
  });

  it("open-ended asks look 12 months ahead and report freeUntil", () => {
    const verdict = evaluateRoomRange({ capacity: 1, moveIn: "2027-01-10", spans: span("2027-06-01", "2027-06-30") });
    expect(verdict).toMatchObject({ available: false, freeUntil: "2027-06-01", firstConflict: { start: "2027-06-01" } });
    expect(evaluateRoomRange({ capacity: 1, moveIn: "2027-01-10", spans: [] })).toEqual({ available: true });
  });

  it("an open-ended occupancy has no end and no next window", () => {
    const verdict = evaluateRoomRange({ ...base, spans: span("2026-01-01", null) });
    expect(verdict.available).toBe(false);
    expect(verdict.firstConflict).toEqual({ start: "2027-01-10", end: null });
    expect(verdict.nextAvailableFrom).toBeUndefined();
  });
});

describe("applyMoveInDateToLabel", () => {
  it("turns Available now into Available from a future date, and leaves the rest alone", () => {
    expect(applyMoveInDateToLabel("Available now", "2026-11-15", "2026-10-09")).toBe("Available from November 15, 2026");
    expect(applyMoveInDateToLabel("Available now", "2026-10-01", "2026-10-09")).toBe("Available now");
    expect(applyMoveInDateToLabel("Available now", "", "2026-10-09")).toBe("Available now");
    expect(applyMoveInDateToLabel("Unavailable (occupied)", "2026-11-15", "2026-10-09")).toBe("Unavailable (occupied)");
    expect(applyMoveInDateToLabel("Available now until December 1, 2026", "2026-11-15", "2026-10-09"))
      .toBe("Available from November 15, 2026 until December 1, 2026");
  });
});

/* ---- Full path: real loadPublicRoomOccupancy over a fake database ---- */

function buildListing() {
  const submission = createDefaultListingSubmission();
  const template = submission.rooms[0]!;
  const room = (id: string, extra: Record<string, unknown> = {}) => ({
    ...template, id, name: `Room ${id}`, monthlyRent: 900, occupancyCapacity: 1, moveInAvailableDate: "", ...extra,
  });
  submission.rooms = [
    room("lease"), room("manual"), room("block"), room("airbnb"),
    room("range", { manualUnavailableRanges: [{ id: "m1", start: "2027-03-01", end: "2027-03-10" }] }),
    room("future", { moveInAvailableDate: "2027-05-01" }),
    room("shared", { occupancyCapacity: 2 }),
    room("open"),
  ] as never;
  return submission;
}

function installDb(submission: ReturnType<typeof buildListing>) {
  const applications = [
    { id: "LEASE-1", manager_user_id: "manager-1", assigned: "home-1", choice: "home-1::lease", lease_start: "2026-11-01", lease_end: "2027-02-28", name: "Alice Resident", email: "alice@example.com" },
    { id: "MANUAL-1", manager_user_id: "manager-1", assigned: "home-1", choice: "home-1::manual", manually_added: "true", manual_start: "2026-10-01", manual_end: "2026-12-31", name: "Carol Manual" },
    { id: "SHARED-1", manager_user_id: "manager-1", assigned: "home-1", choice: "home-1::shared::r1", manually_added: "true", manual_start: "2026-11-01", manual_end: "2026-11-30" },
    { id: "SHARED-2", manager_user_id: "manager-1", assigned: "home-1", choice: "home-1::shared::r2", manually_added: "true", manual_start: "2026-11-15", manual_end: "2026-12-15" },
  ];
  const blocks = [{
    id: "blk-1", property_id: "home-1",
    row_data: { roomId: "block", checkIn: "2026-12-10", checkOut: "2026-12-15", residentName: "Dana Block", bookingStatus: "confirmed" },
  }];
  const calendar = [{
    property_id: "home-1", room_id: "airbnb",
    imported_ranges: [{ sourceUid: "u1", start: "2027-01-10", end: "2027-01-14", guestName: "Bob Guest", reservationCode: "HMSECRET99", provider: "airbnb" }],
  }];
  const leases = [{ manager_user_id: "manager-1", row_data: { executedApplicationId: "LEASE-1" } }];
  fake.db = {
    from(table: string) {
      const query = {
        select() { return this; }, in() { return this; }, eq() { return this; }, or() { return this; }, order() { return this; },
        range(start: number) {
          if (fake.failApplications && table === "manager_application_records") return Promise.resolve({ data: null, error: new Error("db down") });
          const rows = table === "portal_lease_pipeline_records" ? leases
            : table === "portal_schedule_records" ? blocks
            : table === "manager_application_records" ? applications
            : null;
          if (!rows) throw new Error(`Unexpected paged table: ${table}`);
          return Promise.resolve({ data: rows.slice(start), error: null });
        },
        then(resolve: (value: unknown) => unknown) {
          const data = table === "manager_property_records"
            ? [{ id: "home-1", manager_user_id: "manager-1", property_data: { listingSubmission: submission } }]
            : table === "external_calendar_connections" ? calendar : null;
          if (data === null) throw new Error(`Unexpected table: ${table}`);
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return query;
    },
  };
}

describe("roomAvailabilityForRange over the real occupancy reader", () => {
  let submission: ReturnType<typeof buildListing>;
  beforeEach(() => {
    fake.failApplications = false;
    submission = buildListing();
    installDb(submission);
  });

  const ask = (roomId: string, moveIn: string, moveOut?: string) =>
    roomAvailabilityForRange({ propertyId: "home-1", roomId, moveIn, moveOut }, { submission, expectedOwnerId: "manager-1" });

  async function room(roomId: string, moveIn: string, moveOut?: string) {
    const result = await ask(roomId, moveIn, moveOut);
    if (!result.ok) throw new Error(result.message);
    return result.rooms[0]!;
  }

  it("executed lease: blocked during the term, free after", async () => {
    expect(await room("lease", "2026-12-01", "2026-12-05")).toMatchObject({ available: false, firstConflict: { start: "2026-12-01", end: "2027-02-28" }, nextAvailableFrom: "2027-03-01" });
    expect(await room("lease", "2027-03-01", "2027-03-10")).toMatchObject({ available: true });
    expect(await room("lease", "2026-10-15", "2026-10-30")).toMatchObject({ available: true });
  });

  it("manual resident with a moveOut frees the room afterwards", async () => {
    expect(await room("manual", "2026-12-20", "2027-01-05")).toMatchObject({ available: false, nextAvailableFrom: "2027-01-01" });
    expect(await room("manual", "2027-01-01", "2027-02-01")).toMatchObject({ available: true });
  });

  it("room_date_block closes the dates, checkout day is free", async () => {
    expect(await room("block", "2026-12-12", "2026-12-14")).toMatchObject({ available: false, firstConflict: { start: "2026-12-12", end: "2026-12-14" } });
    expect(await room("block", "2026-12-15", "2026-12-20")).toMatchObject({ available: true });
  });

  it("imported Airbnb range blocks without exposing the booking", async () => {
    expect(await room("airbnb", "2027-01-12", "2027-01-16")).toMatchObject({ available: false, firstConflict: { start: "2027-01-12", end: "2027-01-14" } });
  });

  it("the manager's manualUnavailableRanges block", async () => {
    expect(await room("range", "2027-03-05", "2027-03-08")).toMatchObject({ available: false });
    expect(await room("range", "2027-03-11", "2027-03-20")).toMatchObject({ available: true });
  });

  it("a future moveInAvailableDate keeps the room unavailable before that date", async () => {
    expect(await room("future", "2027-04-01", "2027-04-10")).toMatchObject({ available: false, nextAvailableFrom: "2027-05-01" });
    expect(await room("future", "2027-05-01", "2027-05-10")).toMatchObject({ available: true });
  });

  it("shared room is free with one of two beds held and blocked when both are", async () => {
    expect(await room("shared", "2026-11-05", "2026-11-10")).toMatchObject({ available: true });
    expect(await room("shared", "2026-11-20", "2026-11-25")).toMatchObject({ available: false, firstConflict: { start: "2026-11-20", end: "2026-11-30" } });
  });

  it("open-ended asks on an empty room are available", async () => {
    expect(await room("open", "2027-02-01")).toMatchObject({ available: true, rentLabel: expect.any(String) });
  });

  it("checks every room when no roomId is given", async () => {
    const result = await roomAvailabilityForRange({ propertyId: "home-1", moveIn: "2027-01-12", moveOut: "2027-01-14" }, { submission, expectedOwnerId: "manager-1" });
    expect(result.ok && result.rooms.length).toBe(8);
  });

  it("never leaks a name, email, reservation code or source", async () => {
    const all = await roomAvailabilityForRange({ propertyId: "home-1", moveIn: "2026-10-01", moveOut: "2027-06-30" }, { submission, expectedOwnerId: "manager-1" });
    const json = JSON.stringify(all);
    for (const secret of SECRETS) expect(json).not.toContain(secret);
    for (const key of ["name", "email", "guestName", "reservationCode", "provider", "source", "kind"]) {
      expect(json).not.toMatch(new RegExp(`"${key}"`));
    }
  });

  it("fails closed: a read failure is available null, never available", async () => {
    fake.failApplications = true;
    const result = await ask("open", "2027-02-01", "2027-02-05");
    expect(result).toMatchObject({ ok: true, verified: false });
    if (result.ok) expect(result.rooms[0]).toMatchObject({ available: null, note: expect.stringContaining("Could not verify") });
  });

  it("rejects bad dates and unknown rooms", async () => {
    expect(await ask("open", "2027-02-30")).toMatchObject({ ok: false, error: "invalid_dates" });
    expect(await ask("open", "2027-02-05", "2027-02-05")).toMatchObject({ ok: false, error: "invalid_dates" });
    expect(await ask("nope", "2027-02-05", "2027-02-06")).toMatchObject({ ok: false, error: "room_not_found" });
  });
});

/* ---- Tools and registries ---- */

describe("check_room_availability tools", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T18:00:00Z"));
    fake.failApplications = false;
    __resetLeasingCatalogCache();
    __resetSmsOccupancyCache();
    const submission = buildListing();
    installDb(submission);
    const property = { id: "home-1", title: "Cedar House", address: "1 Cedar St", listingSubmission: submission };
    fake.catalog = [property];
    grants.read = new Set(["home-1"]);
  });
  afterEach(() => vi.useRealTimers());

  const row = () => ({ id: "home-1", status: "live", property_data: fake.catalog[0], row_data: null });
  function dbWithRows() {
    const q: Record<string, unknown> = {};
    let wantedId: unknown = null;
    for (const m of ["select", "in", "order", "limit"]) q[m] = () => q;
    q.eq = (column: string, value: unknown) => { if (column === "id") wantedId = value; return q; };
    q.maybeSingle = async () => ({ data: wantedId === null || wantedId === "home-1" ? row() : null, error: null });
    q.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [{ ...row(), manager_user_id: "manager-1" }], error: null }).then(resolve);
    return { from: () => q };
  }

  it("prospect tool answers for the scoped listing and keeps the secrets out", async () => {
    const ctx = { landlordId: "manager-1", userId: "manager-1", roles: ["manager"], isAdmin: false, db: dbWithRows(), listingPublicOnly: true } as unknown as AgentContext;
    const out = await checkRoomAvailabilityTool.handler(ctx, { listingId: "home-1", roomId: "airbnb", moveIn: "2027-01-12", moveOut: "2027-01-16" });
    expect(out).toMatchObject({ found: true, ok: true, rooms: [{ roomId: "airbnb", available: false, firstConflict: { start: "2027-01-12", end: "2027-01-14" } }] });
    for (const secret of SECRETS) expect(JSON.stringify(out)).not.toContain(secret);
    expect(await checkRoomAvailabilityTool.handler(ctx, { listingId: "other", moveIn: "2027-01-12" })).toEqual({ found: false });
    expect(await checkRoomAvailabilityTool.handler(ctx, { listingId: "home-1", moveIn: "2026-10-01" })).toMatchObject({ ok: false, error: "invalid_dates" });
  });

  it("get_listing_details currentAvailability respects a future moveInAvailableDate", async () => {
    const ctx = { landlordId: "manager-1", userId: "manager-1", roles: ["manager"], isAdmin: false, db: dbWithRows(), listingPublicOnly: true } as unknown as AgentContext;
    const out = await getListingDetailsTool.handler(ctx, { propertyId: "home-1", roomQuery: "Room future" });
    if (!out.found) throw new Error("listing not found");
    expect(out.listing.rooms[0]).toMatchObject({ currentAvailabilityVerified: true, currentAvailability: "Available from May 1, 2027" });
    const open = await getListingDetailsTool.handler(ctx, { propertyId: "home-1", roomQuery: "Room open" });
    if (!open.found) throw new Error("listing not found");
    expect(open.listing.rooms[0]?.currentAvailability).toBe("Available now");
  });

  it("resident SMS wrapper reads the same answer through the manager's public inventory", async () => {
    const ctx = {
      kind: "resident", userId: "resident-1", email: "r@example.com", managerIds: ["manager-1"], activeManagerId: "manager-1",
      landlordId: "resident-1", channel: "sms", phase: "application", managerTier: null, db: dbWithRows(),
    } as unknown as ResidentAgentContext;
    const out = await residentSmsCheckRoomAvailabilityTool.handler(ctx, { listingId: "home-1", roomId: "open", moveIn: "2027-02-01", moveOut: "2027-02-05" });
    expect(out).toMatchObject({ found: true, ok: true, rooms: [{ available: true }] });
  });

  it("manager tool is scoped to calendar-readable houses and rejects others", async () => {
    const ctx = { landlordId: "manager-1", userId: "manager-1", email: "m@example.com", roles: ["manager"], isAdmin: false, db: dbWithRows() } as unknown as AgentContext;
    const out = await checkManagerRoomAvailabilityTool.handler(ctx, { listingId: "home-1", roomId: "block", moveIn: "2026-12-12", moveOut: "2026-12-14" });
    expect(out).toMatchObject({ found: true, ok: true, rooms: [{ roomId: "block", available: false }] });
    grants.read = new Set();
    await expect(checkManagerRoomAvailabilityTool.handler(ctx, { listingId: "home-1", moveIn: "2027-01-01" })).rejects.toThrow(/No property/);
  });
});

describe("registry membership", () => {
  const residentCtx = (channel: "sms" | "portal") =>
    ({ kind: "resident", channel, phase: "application", managerTier: null, userId: "r", email: "r@e.com", managerIds: ["m"], activeManagerId: "m", landlordId: "r", db: {} }) as unknown as ResidentAgentContext;

  it("prospect leasing registries (SMS, email, voice, autonomous tour) expose it and never list_bookings", () => {
    for (const registry of [leasingSmsAgentRegistry, leasingSmsAutonomousTourRegistry]) {
      expect(registry.get("check_room_availability")?.kind).toBe("read");
      expect(registry.has("list_bookings")).toBe(false);
    }
  });

  it("application-phase resident SMS exposes it and never list_bookings", () => {
    const registry = buildResidentRegistry(residentCtx("sms"));
    expect(registry.get("check_room_availability")?.kind).toBe("read");
    expect(registry.has("list_bookings")).toBe(false);
  });

  it("manager registry and MCP calendar area expose it as a read tool", () => {
    expect(agentRegistry.get("check_room_availability")?.kind).toBe("read");
    expect(agentRegistry.has("list_bookings")).toBe(true);
    const calendar = API_KEY_PRODUCT_AREAS.find((area) => area.id === "calendar")!;
    expect(calendar.readTools).toContain("check_room_availability");
    expect(mcpToolCatalog().find((tool) => tool.name === "check_room_availability")?.kind).toBe("read");
  });
});
