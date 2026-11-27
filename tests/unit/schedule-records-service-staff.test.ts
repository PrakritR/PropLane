/**
 * Service mode: staff of the open workspace see and edit the bookings the workspace OWNER typed by hand
 * (stamped to the owner, so the owner column alone hid them). A stranger, and a manager with only their
 * own rows, do not. The route is the shared JSON-record route; its hooks are driven directly.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { serviceStaffScope } from "@/lib/service/service-mode";
import type { PortalWorkspace } from "@/lib/workspaces/types";

const mocks = vi.hoisted(() => ({
  linked: vi.fn(),
  config: null as null | Record<string, unknown>,
  canWrite: vi.fn(),
  projected: [] as Record<string, unknown>[],
  hosts: vi.fn(),
}));

vi.mock("@/lib/portal-record-api", () => ({
  createJsonRecordRoute: (config: Record<string, unknown>) => {
    mocks.config = config;
    return { GET: vi.fn(), POST: vi.fn() };
  },
}));
vi.mock("@/lib/planned-schedule-persistence.server", () => ({ replaceManagerPlannedScheduleSlice: vi.fn() }));
vi.mock("@/lib/auth/manager-lease-scope", () => ({ managerCanWriteCalendarForProperty: mocks.canWrite }));
vi.mock("@/lib/workspaces/scope.server", () => ({ activeWorkspacePropertyScope: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/auth/co-manager-module-scope", () => ({
  linkedOwnerScopeForModule: mocks.linked,
}));
vi.mock("@/lib/schedule-record-projection.server", () => ({
  PARTNER_INQUIRIES_RECORD_ID: "axis_admin_partner_inquiries_v1",
  PLANNED_EVENTS_RECORD_ID: "axis_admin_planned_events_v1",
  // The ordinary projection keeps only rows the viewer wrote: what the owner's block never was.
  projectScheduleRecordsForViewer: vi.fn(async (_db: unknown, user: { id: string }, records: Record<string, unknown>[]) =>
    records.filter((record) => record.manager_user_id === user.id),
  ),
  tourHostIdsByHouse: mocks.hosts,
}));

await import("@/app/api/portal-schedule-records/route");

type Hook = (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
const hook = (name: string) => mocks.config![name] as Hook;

const OWNER = "ambika";
const CO_HOST = "co-host-b";
const OPERATOR = "operator-1";
const HOUSE = "house-5257";
const ownerBlock = {
  id: `axis_room_block_${OWNER}_hand-1`,
  manager_user_id: OWNER,
  property_id: HOUSE,
  record_type: "room_date_block",
  row_data: { checkIn: "2026-10-22", checkOut: "2026-10-25", roomId: "r1", residentName: "Direct guest" },
};
const staff = { id: "staff-1", role: "manager", roles: ["manager"], serviceScope: { workspaceId: "ws-1", propertyIds: [HOUSE] } };
const stranger = { id: "stranger-1", role: "manager", roles: ["manager"], serviceScope: null };

// A tour request the workspace's CLIENT owner holds on a managed house; the viewer has no co-manager seat.
const ownerTour = {
  id: "partner_inquiry_request_t1",
  manager_user_id: OWNER,
  property_id: HOUSE,
  record_type: "partner_inquiry_request",
  row_data: { id: "t1", recordType: "partner_inquiry_request", payload: { id: "t1", kind: "tour", status: "pending", propertyId: HOUSE } },
};

/** A thenable query that records its filters; the staff read (a record_type filter) answers with the owner's block. */
function fakeDb() {
  const calls: Array<{ table: string; ins: Record<string, unknown> }> = [];
  return {
    calls,
    from(table: string) {
      const rec = { table, ins: {} as Record<string, unknown> };
      calls.push(rec);
      const query: Record<string, unknown> = {};
      for (const name of ["select", "neq", "order", "limit", "eq"]) query[name] = () => query;
      query.in = (column: string, values: unknown) => {
        rec.ins[column] = values;
        return query;
      };
      query.like = (column: string, pattern: string) => {
        rec.ins[`like:${column}`] = pattern;
        return query;
      };
      query.or = (filter: string) => {
        rec.ins.orFilter = filter;
        return query;
      };
      query.then = (resolve: (value: unknown) => unknown) => {
        if (table === "manager_property_records") return Promise.resolve({ data: [{ id: HOUSE, manager_user_id: OWNER }], error: null }).then(resolve);
        const houses = (rec.ins.property_id ?? rec.ins["row_data->>propertyId"]) as string[] | undefined;
        const data = rec.ins["like:record_type"]
          ? houses?.includes(ownerTour.property_id) ? [ownerTour] : []
          : rec.ins.record_type ? [ownerBlock] : [];
        return Promise.resolve({ data, error: null }).then(resolve);
      };
      return query;
    },
  };
}

beforeEach(() => {
  mocks.linked.mockReset().mockResolvedValue({ ownerIds: new Set(), propertyIds: new Set(), propertyIdsByOwner: new Map() });
  mocks.canWrite.mockReset().mockResolvedValue(false);
  mocks.hosts.mockReset().mockImplementation(async (_db: unknown, owners: Map<string, string>) =>
    new Map([...owners.keys()].map((house) => [house, new Set([owners.get(house)!, CO_HOST, OPERATOR])])),
  );
});

describe("pure scope", () => {
  const ws = (over: Partial<PortalWorkspace>) => ({ id: "ws-1", isService: true, propertyIds: [HOUSE], ...over }) as PortalWorkspace;
  it("staff of the open service workspace get that workspace's houses", () => {
    expect(serviceStaffScope([ws({})], new Set(["ws-1"]), "ws-1")).toEqual({ workspaceId: "ws-1", propertyIds: [HOUSE] });
  });
  it("a stranger (not staff), or staff on their own non-service workspace, get nothing", () => {
    expect(serviceStaffScope([ws({})], new Set(), "ws-1")).toBeNull();
    expect(serviceStaffScope([ws({ isService: false })], new Set(["ws-1"]), "ws-1")).toBeNull();
    expect(serviceStaffScope([ws({}), ws({ id: "own", isService: false })], new Set(["ws-1"]), "own")).toBeNull();
  });
});

describe("service staff and the owner's hand-typed bookings", () => {
  it("staff read the owner's room block; the ordinary projection alone would have dropped it", async () => {
    const db = fakeDb();
    const read = await hook("readRecords")({ db, user: staff });
    const rows = await hook("projectRead")({ db, user: staff, records: read.data });
    expect(rows.map((r: Record<string, unknown>) => r.id)).toEqual([ownerBlock.id]);
  });

  it("a stranger asks for nothing extra and sees nothing of the owner's", async () => {
    const db = fakeDb();
    const read = await hook("readRecords")({ db, user: stranger });
    expect(db.calls.some((c) => c.ins.record_type)).toBe(false);
    const rows = await hook("projectRead")({ db, user: stranger, records: [ownerBlock] });
    expect(rows).toEqual([]);
  });

  it("the visibility scope used before an edit or delete reaches the workspace's blocks for staff only", () => {
    const filters: string[] = [];
    const q = { or: (f: string) => (filters.push(f), q) };
    (mocks.config!.scope as (q: unknown, u: unknown) => unknown)(q, staff);
    (mocks.config!.scope as (q: unknown, u: unknown) => unknown)(q, stranger);
    expect(filters[0]).toContain(`and(property_id.in.(${HOUSE}),record_type.in.(room_date_block,cancelled_room_date_block))`);
    expect(filters[1]).not.toContain("property_id.in");
  });

  it("staff may edit and delete the owner's block without a co-manager grant; a stranger may not", async () => {
    const edit = { ...ownerBlock, row_data: { ...ownerBlock.row_data, residentName: "Direct guest (edited)" } };
    const asStaff = await hook("atomicWrite")({ db: fakeDb(), user: staff, record: { ...edit }, existing: ownerBlock });
    expect(asStaff).not.toMatchObject({ status: 403 });
    const asStranger = await hook("atomicWrite")({ db: {}, user: stranger, record: { ...edit }, existing: ownerBlock });
    expect(asStranger).toMatchObject({ handled: true, status: 403 });
    expect(await hook("authorizeDelete")({ db: {}, user: staff, records: [ownerBlock] })).toEqual({ ok: true });
    expect(await hook("authorizeDelete")({ db: {}, user: stranger, records: [ownerBlock] })).toMatchObject({ ok: false, status: 403 });
  });

  it("staff scope never reaches a house outside the workspace", async () => {
    const elsewhere = { ...ownerBlock, property_id: "someone-elses-house" };
    expect(await hook("authorizeDelete")({ db: {}, user: staff, records: [elsewhere] })).toMatchObject({ ok: false, status: 403 });
    const rows = await hook("projectRead")({ db: {}, user: staff, records: [elsewhere] });
    expect(rows).toEqual([]);
  });
});

describe("service staff and the client owner's pending tours", () => {
  // The projection is mocked above to "rows the viewer wrote"; for these cases use the real rule for staff houses.
  it("staff with NO co-manager seat read the client-owned pending tour on a managed house", async () => {
    const db = fakeDb();
    const read = await hook("readRecords")({ db, user: staff });
    expect(read.error).toBeNull();
    expect((read.data as Record<string, unknown>[]).map((r) => r.id)).toContain(ownerTour.id);
    const tourReads = db.calls.filter((c) => c.ins["like:record_type"]);
    expect(tourReads.length).toBe(2);
    for (const call of tourReads) {
      expect(call.ins.property_id ?? call.ins["row_data->>propertyId"]).toEqual([HOUSE]);
      // Only rows stamped to the house's owner or an eligible host (or no one) are fetched, so a planted row is never read.
      expect(call.ins.orFilter).toBe(`manager_user_id.is.null,manager_user_id.in.(${OWNER},${CO_HOST},${OPERATOR})`);
    }
    expect(mocks.hosts).toHaveBeenCalledWith(db, new Map([[HOUSE, OWNER]]), true);
  });

  it("an unreadable host roster is an error and fetches no tour rows", async () => {
    mocks.hosts.mockRejectedValue(new Error("account_link_invites unreadable"));
    const db = fakeDb();
    const read = await hook("readRecords")({ db, user: staff });
    expect(read.data).toBeNull();
    expect(read.error).toMatchObject({ message: expect.any(String) });
    expect(db.calls.some((c) => c.ins["like:record_type"])).toBe(false);
  });

  it("an unreadable owner lookup is an error and fetches no tour rows", async () => {
    const db = fakeDb();
    const from = db.from.bind(db);
    db.from = (table: string) => {
      if (table !== "manager_property_records") return from(table);
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.in = () => Promise.resolve({ data: null, error: { message: "boom" } });
      return q as never;
    };
    const read = await hook("readRecords")({ db, user: staff });
    expect(read.data).toBeNull();
    expect(read.error).toMatchObject({ message: expect.any(String) });
    expect(db.calls.some((c) => c.ins["like:record_type"])).toBe(false);
  });

  it("refuses a non-admin upsert of an inquiry naming a house the caller holds no Calendar edit on", async () => {
    const planted = {
      id: "planted", record_type: "partner_inquiry_request", property_id: null,
      row_data: { payload: { kind: "tour", propertyId: HOUSE } },
    };
    expect(await hook("authorizeUpsert")({ db: {}, user: stranger, records: [planted] })).toMatchObject({ ok: false, status: 403 });
    mocks.canWrite.mockResolvedValue(true);
    expect(await hook("authorizeUpsert")({ db: {}, user: stranger, records: [planted] })).toMatchObject({ ok: true });
  });

  it("a non-staff viewer, and staff of a different workspace, read no tour of that house", async () => {
    const db = fakeDb();
    const read = await hook("readRecords")({ db, user: stranger });
    expect(db.calls.some((c) => c.ins["like:record_type"])).toBe(false);
    expect((read.data as Record<string, unknown>[]).map((r) => r.id)).not.toContain(ownerTour.id);

    const otherStaff = { ...staff, id: "staff-2", serviceScope: { workspaceId: "ws-2", propertyIds: ["house-other"] } };
    const otherDb = fakeDb();
    const otherRead = await hook("readRecords")({ db: otherDb, user: otherStaff });
    expect((otherRead.data as Record<string, unknown>[]).map((r) => r.id)).not.toContain(ownerTour.id);
    for (const call of otherDb.calls.filter((c) => c.ins["like:record_type"])) {
      expect(JSON.stringify(call.ins)).not.toContain(HOUSE);
    }
  });

  it("the edit/delete visibility scope is not widened to tour requests", () => {
    const filters: string[] = [];
    const q = { or: (f: string) => (filters.push(f), q) };
    (mocks.config!.scope as (q: unknown, u: unknown) => unknown)(q, staff);
    expect(filters[0]).not.toContain("record_type.like");
  });

  it("an unreadable co-manager lookup is an error, never {data: []}", async () => {
    mocks.linked.mockRejectedValue(new Error("PGRST002"));
    const read = await hook("readRecords")({ db: fakeDb(), user: staff });
    expect(read.data).toBeNull();
    expect(read.error).toMatchObject({ message: expect.any(String) });
    expect(mocks.linked).toHaveBeenCalledWith(expect.anything(), staff.id, "calendar", "read", { throwOnError: true });
  });

  it("the route asks for the strict staff-scope read and the strict projection", async () => {
    expect(mocks.config!.strictServiceScopeOnRead).toBe(true);
    const projection = await import("@/lib/schedule-record-projection.server");
    await hook("projectRead")({ db: {}, user: staff, records: [] });
    expect(projection.projectScheduleRecordsForViewer).toHaveBeenLastCalledWith({}, staff, [], { throwOnError: true });
  });
});
