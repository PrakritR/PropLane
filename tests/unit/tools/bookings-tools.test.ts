import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentContext } from "@/lib/tools/context";
import { executeWrite, previewWrite } from "./fake-agent-ctx";

// Property access is a policy decision owned by manager-lease-scope; stub it with a mutable grant table.
const grants = vi.hoisted(() => ({ read: new Set<string>(), edit: new Set<string>() }));
vi.mock("@/lib/auth/manager-lease-scope", () => ({
  managerHasCalendarAccessForProperty: vi.fn(async (_db: unknown, _user: string, propertyId: string) => grants.read.has(propertyId)),
  managerCanWriteCalendarForProperty: vi.fn(async (_db: unknown, _user: string, propertyId: string) => grants.edit.has(propertyId)),
}));

const snapshot = vi.hoisted(() => ({
  calls: [] as Array<{ propertyIds: string[]; from: string; to: string }>,
  stays: [] as Array<Record<string, unknown>>,
}));
vi.mock("@/lib/occupancy/snapshot.server", () => ({
  occupancySnapshotForManager: vi.fn(async (_db: unknown, _user: string, input: { propertyIds: string[]; from: string; to: string }) => {
    snapshot.calls.push(input);
    return {
      days: [{ dayKey: input.from, occupied: 1, total: 2, checkIns: 0, checkOuts: 0, houses: input.propertyIds.map((propertyId) => ({ propertyId, occupied: 1, total: 2, checkIns: 0, checkOuts: 0 })) }],
      stays: snapshot.stays.filter((s) => input.propertyIds.includes(String(s.propertyId))),
      version: "v",
    };
  }),
}));
vi.mock("@/lib/channel-calendar/bookings.server", () => ({
  listManagerChannelCalendarBookings: vi.fn(async (_db: unknown, _user: string, propertyIds: string[]) =>
    propertyIds.includes("prop_a")
      ? [{ propertyId: "prop_a", propertyLabel: "12 Main", rooms: [{ roomId: "room_1", provider: "airbnb", ranges: [{ sourceUid: "u", start: "2026-10-20", end: "2026-10-22", summary: "Reserved" }] }] }]
      : [],
  ),
}));

import {
  blockRoomDatesTool,
  listBookingsTool,
  listRoomBlocksTool,
  removeRoomBlockTool,
} from "@/lib/tools/domains/bookings";
import { agentRegistry, buildManagerSmsRegistry } from "@/lib/tools";
import { API_KEY_PRODUCT_AREAS, API_KEY_TOOL_NAMES, API_KEY_WRITE_TOOL_NAMES } from "@/lib/mcp/capabilities";
import { mcpToolCatalog } from "@/lib/mcp/catalog";

type Row = Record<string, unknown>;

/** Chainable, awaitable stand-in for the supabase query builder with select/insert/delete over seeded tables. */
function makeCtx(store: Record<string, Row[]>): AgentContext {
  class Q {
    private filters: Array<(r: Row) => boolean> = [];
    private op: "select" | "delete" = "select";
    constructor(private table: string) {
      store[table] ??= [];
    }
    select() { return this; }
    limit() { return this; }
    order() { return this; }
    eq(col: string, val: unknown) { this.filters.push((r) => r[col] === val); return this; }
    in(col: string, vals: unknown[]) { this.filters.push((r) => vals.includes(r[col])); return this; }
    delete() { this.op = "delete"; return this; }
    update() { return this; }
    insert(row: Row) {
      if (this.table === "audit_log" && row.dedupe_key != null && store.audit_log!.some((r) => r.dedupe_key === row.dedupe_key)) {
        return Promise.resolve({ data: null, error: { code: "23505", message: "duplicate" } });
      }
      store[this.table]!.push({ ...row });
      return Promise.resolve({ data: null, error: null });
    }
    then<T>(resolve: (v: { data: Row[]; error: null }) => T) {
      const matched = store[this.table]!.filter((r) => this.filters.every((f) => f(r)));
      if (this.op === "delete") store[this.table] = store[this.table]!.filter((r) => !matched.includes(r));
      return Promise.resolve({ data: matched, error: null }).then(resolve);
    }
  }
  return {
    landlordId: "manager_a",
    userId: "manager_a",
    email: "a@axis.test",
    roles: ["manager"],
    isAdmin: false,
    db: { from: (table: string) => new Q(table) },
  } as unknown as AgentContext;
}

function property(id: string, owner: string, title: string): Row {
  return {
    id,
    manager_user_id: owner,
    row_data: {},
    property_data: { title, listingSubmission: { rooms: [{ id: "room_1", name: "Room 1" }, { id: "room_2", name: "Room 2" }] } },
  };
}

function blockRecord(id: string, propertyId: string, data: Row): Row {
  return {
    id,
    property_id: propertyId,
    record_type: "room_date_block",
    row_data: { id, propertyId, roomId: "", reason: "", ...data },
  };
}

let store: Record<string, Row[]>;
let ctx: AgentContext;

beforeEach(() => {
  grants.read = new Set(["prop_a"]);
  grants.edit = new Set(["prop_a"]);
  snapshot.calls = [];
  snapshot.stays = [];
  store = {
    manager_property_records: [property("prop_a", "manager_a", "12 Main"), property("prop_b", "manager_b", "99 Other")],
    portal_schedule_records: [
      blockRecord("axis_room_block_manager_a_1", "prop_a", { roomId: "room_1", checkIn: "2026-11-01", checkOut: "2026-11-05", reason: "Paint", residentName: "Jo Hold", rate: 900, rateBasis: "monthly" }),
      blockRecord("axis_room_block_manager_b_9", "prop_b", { roomId: "room_1", checkIn: "2026-11-01", checkOut: "2026-11-05", reason: "Other" }),
    ],
    audit_log: [],
  };
  ctx = makeCtx(store);
});

describe("list_bookings", () => {
  it("returns per-property rooms with entries, rent, source and occupancy", async () => {
    snapshot.stays = [
      { id: "s1", propertyId: "prop_a", roomId: "room_1", roomLabel: "Room 1", start: "2026-10-10", end: "2026-12-31", kind: "lease", name: "Ana Resident", monthlyRent: 1500 },
      { id: "s2", propertyId: "prop_a", roomId: "room_1", roomLabel: "Room 1", start: "2026-11-01", end: "2026-11-04", kind: "hold", name: "Jo Hold" },
      { id: "s3", propertyId: "prop_a", roomId: "room_1", roomLabel: "Room 1", start: "2026-10-20", end: "2026-10-22", kind: "guest", name: "Reserved" },
      { id: "s4", propertyId: "prop_a", roomId: "room_2", roomLabel: "Room 2", start: "2027-06-01", end: "2027-06-03", kind: "lease", name: "Outside window" },
    ];
    const out = (await listBookingsTool.handler(ctx, { from: "2026-10-09", to: "2026-12-31" })) as {
      count: number;
      properties: Array<{ propertyId: string; occupancy: Record<string, unknown>; rooms: Array<{ roomId: string; entries: Array<Record<string, unknown>> }> }>;
    };
    expect(out.properties.map((p) => p.propertyId)).toEqual(["prop_a"]);
    expect(out.properties[0]!.occupancy).toMatchObject({ occupied: 1, total: 2, onDate: "2026-10-09" });
    const entries = out.properties[0]!.rooms.flatMap((r) => r.entries);
    expect(out.count).toBe(3);
    expect(entries.find((e) => e.name === "Ana Resident")).toMatchObject({ kind: "lease", rent: { amount: 1500, basis: "monthly" }, source: "PropLane lease" });
    expect(entries.find((e) => e.name === "Jo Hold")).toMatchObject({ blockId: "axis_room_block_manager_a_1", rent: { amount: 900, basis: "monthly" } });
    expect(entries.find((e) => e.name === "Reserved")).toMatchObject({ source: "Airbnb booking" });
  });

  it("never hands the snapshot a property the manager cannot read the calendar for", async () => {
    await listBookingsTool.handler(ctx, {});
    expect(snapshot.calls).toHaveLength(1);
    expect(snapshot.calls[0]!.propertyIds).toEqual(["prop_a"]);
    const defaultSpan = Date.parse(`${snapshot.calls[0]!.to}T00:00:00Z`) - Date.parse(`${snapshot.calls[0]!.from}T00:00:00Z`);
    expect(defaultSpan / 86_400_000).toBe(90);
  });

  it("refuses another manager's property and an unreadable one", async () => {
    await expect(listBookingsTool.handler(ctx, { propertyId: "prop_b" })).rejects.toThrow(/No property/);
    grants.read = new Set();
    await expect(listBookingsTool.handler(ctx, { propertyId: "prop_a" })).rejects.toThrow(/No property/);
    expect(await listBookingsTool.handler(ctx, {})).toMatchObject({ count: 0, properties: [] });
  });

  it("rejects bad dates and oversized windows", async () => {
    await expect(listBookingsTool.handler(ctx, { from: "2026-02-30" })).rejects.toThrow(/real calendar dates/);
    await expect(listBookingsTool.handler(ctx, { from: "2026-10-10", to: "2026-10-01" })).rejects.toThrow(/before/);
    await expect(listBookingsTool.handler(ctx, { from: "2026-01-01", to: "2028-01-01" })).rejects.toThrow(/at most/);
  });
});

describe("list_room_blocks", () => {
  it("lists only blocks on readable properties", async () => {
    const out = (await listRoomBlocksTool.handler(ctx, {})) as { count: number; blocks: Array<Record<string, unknown>> };
    expect(out.count).toBe(1);
    expect(out.blocks[0]).toMatchObject({ id: "axis_room_block_manager_a_1", propertyTitle: "12 Main", roomLabel: "Room 1", heldFor: "Jo Hold", rate: 900 });
    expect(out.blocks[0]).not.toHaveProperty("residentEmail");
  });

  it("refuses an explicit propertyId the manager cannot read", async () => {
    await expect(listRoomBlocksTool.handler(ctx, { propertyId: "prop_b" })).rejects.toThrow(/No property/);
  });
});

describe("block_room_dates", () => {
  const input = { propertyId: "prop_a", roomId: "room_2", start: "2026-12-01", end: "2026-12-04", reason: "Deep clean", residentName: "Pat" };

  it("previews house, room and dates", async () => {
    const res = await previewWrite(blockRoomDatesTool, ctx, input);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.destructive).toBe(false);
    expect(res.preview.summary).toContain("Room 2");
    expect(res.preview.summary).toContain("12 Main");
    expect(res.preview.fields).toEqual(
      expect.arrayContaining([
        { label: "House", value: "12 Main" },
        { label: "Room", value: "Room 2" },
        expect.objectContaining({ label: "Dates", value: expect.stringContaining("Dec 1, 2026 to Dec 4, 2026 (3 nights") }),
        { label: "Held for", value: "Pat" },
      ]),
    );
  });

  it("warns, without refusing, when the range is already occupied", async () => {
    snapshot.stays = [{ id: "s", propertyId: "prop_a", roomId: "room_2", roomLabel: "Room 2", start: "2026-11-20", end: "2026-12-02", kind: "lease", name: "Ana" }];
    const res = await previewWrite(blockRoomDatesTool, ctx, input);
    expect(res.ok && res.preview.warnings?.[0]).toContain("Ana");
  });

  it("refuses another manager's property, a read-only grant, a bad room, bad dates and overlaps", async () => {
    expect(await previewWrite(blockRoomDatesTool, ctx, { ...input, propertyId: "prop_b" })).toMatchObject({ ok: false, error: expect.stringContaining("No property") });
    grants.edit = new Set();
    expect(await previewWrite(blockRoomDatesTool, ctx, input)).toMatchObject({ ok: false, error: expect.stringContaining("permission") });
    grants.edit = new Set(["prop_a"]);
    expect(await previewWrite(blockRoomDatesTool, ctx, { ...input, roomId: "room_9" })).toMatchObject({ ok: false, error: expect.stringContaining("No room") });
    expect(await previewWrite(blockRoomDatesTool, ctx, { ...input, end: "2026-12-01" })).toMatchObject({ ok: false, error: expect.stringContaining("after start") });
    expect(await previewWrite(blockRoomDatesTool, ctx, { ...input, roomId: "room_1", start: "2026-11-04", end: "2026-11-06" })).toMatchObject({ ok: false, error: expect.stringContaining("already blocked") });
    // Check-out is exclusive: starting on the existing block's check-out day is free.
    expect((await previewWrite(blockRoomDatesTool, ctx, { ...input, roomId: "room_1", start: "2026-11-05", end: "2026-11-06" })).ok).toBe(true);
  });

  it("handler re-checks permission and writes the saveRoomDateBlock row shape", async () => {
    grants.edit = new Set();
    expect(await executeWrite(blockRoomDatesTool, ctx, input)).toMatchObject({ ok: false, error: expect.stringContaining("permission") });
    expect(store.portal_schedule_records).toHaveLength(2);

    grants.edit = new Set(["prop_a"]);
    const res = await executeWrite(blockRoomDatesTool, ctx, input);
    expect(res.ok).toBe(true);
    const written = store.portal_schedule_records!.find((r) => r.manager_user_id === "manager_a")!;
    expect(written).toMatchObject({
      property_id: "prop_a",
      record_type: "room_date_block",
      starts_at: "2026-12-01T00:00:00",
      ends_at: "2026-12-04T00:00:00",
    });
    expect(String(written.id)).toMatch(/^axis_room_block_manager_a_/);
    expect(written.row_data).toMatchObject({
      propertyId: "prop_a",
      roomId: "room_2",
      checkIn: "2026-12-01",
      checkOut: "2026-12-04",
      reason: "Deep clean",
      residentName: "Pat",
      bookingStatus: "hold",
      recordType: "room_date_block",
    });
    expect(store.audit_log).toHaveLength(1);

    // Same block again is reported as already done, not duplicated.
    const again = await executeWrite(blockRoomDatesTool, ctx, input);
    expect(again.reply).toMatch(/Already done/);
    expect(store.portal_schedule_records!.filter((r) => r.manager_user_id === "manager_a")).toHaveLength(1);
  });
});

describe("remove_room_block", () => {
  it("is destructive and previews the block it will remove", async () => {
    const res = await previewWrite(removeRoomBlockTool, ctx, { blockId: "axis_room_block_manager_a_1" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.destructive).toBe(true);
    expect(res.preview.fields).toEqual(expect.arrayContaining([{ label: "House", value: "12 Main" }, { label: "Room", value: "Room 1" }]));
  });

  it("answers identically for a missing block and another manager's block", async () => {
    const foreign = await previewWrite(removeRoomBlockTool, ctx, { blockId: "axis_room_block_manager_b_9" });
    const missing = await previewWrite(removeRoomBlockTool, ctx, { blockId: "axis_room_block_manager_b_404" });
    expect(foreign).toMatchObject({ ok: false, error: expect.stringContaining("No room block") });
    expect(missing).toMatchObject({ ok: false, error: expect.stringContaining("No room block") });
    expect(await executeWrite(removeRoomBlockTool, ctx, { blockId: "axis_room_block_manager_b_9" })).toMatchObject({ ok: false });
    expect(store.portal_schedule_records).toHaveLength(2);
  });

  it("requires calendar edit, refuses imported channel stays, and deletes on success", async () => {
    grants.edit = new Set();
    expect(await executeWrite(removeRoomBlockTool, ctx, { blockId: "axis_room_block_manager_a_1" })).toMatchObject({ ok: false, error: expect.stringContaining("permission") });
    grants.edit = new Set(["prop_a"]);
    store.portal_schedule_records!.push(blockRecord("axis_room_block_manager_a_air", "prop_a", { checkIn: "2026-12-10", checkOut: "2026-12-12", reason: "Airbnb" }));
    expect(await executeWrite(removeRoomBlockTool, ctx, { blockId: "axis_room_block_manager_a_air" })).toMatchObject({ ok: false, error: expect.stringContaining("channel") });

    expect((await executeWrite(removeRoomBlockTool, ctx, { blockId: "axis_room_block_manager_a_1" })).ok).toBe(true);
    expect(store.portal_schedule_records!.map((r) => r.id)).not.toContain("axis_room_block_manager_a_1");
    expect(store.portal_schedule_records!.map((r) => r.id)).toContain("axis_room_block_manager_b_9");
  });
});

describe("registration", () => {
  const reads = ["list_bookings", "list_room_blocks"];
  const writes = ["block_room_dates", "remove_room_block"];

  it("is in the manager registry, the calendar product area and the public catalog", () => {
    const calendar = API_KEY_PRODUCT_AREAS.find((a) => a.id === "calendar")!;
    for (const name of reads) {
      expect(agentRegistry.get(name)?.kind).toBe("read");
      expect(calendar.readTools).toContain(name);
      expect(API_KEY_TOOL_NAMES.has(name)).toBe(true);
    }
    for (const name of writes) {
      expect(agentRegistry.get(name)?.kind).toBe("write");
      expect(calendar.writeTools).toContain(name);
      expect(API_KEY_WRITE_TOOL_NAMES.has(name)).toBe(true);
    }
    const catalog = new Map(mcpToolCatalog().map((t) => [t.name, t.kind]));
    for (const name of reads) expect(catalog.get(name)).toBe("read");
    for (const name of writes) expect(catalog.get(name)).toBe("write");
  });

  it("manager SMS keeps block_room_dates and withholds the destructive remove_room_block", () => {
    const sms = buildManagerSmsRegistry();
    expect(sms.has("block_room_dates")).toBe(true);
    expect(sms.has("list_bookings")).toBe(true);
    expect(sms.has("remove_room_block")).toBe(false);
    // A delegated (someone else's number) turn never reaches these tools.
    const delegated = buildManagerSmsRegistry({ mode: "delegated" } as Parameters<typeof buildManagerSmsRegistry>[0]);
    for (const name of [...reads, ...writes]) expect(delegated.has(name)).toBe(false);
  });
});
