/**
 * Service mode: staff of the open workspace see and edit the bookings the workspace OWNER typed by hand
 * (stamped to the owner, so the owner column alone hid them). A stranger, and a manager with only their
 * own rows, do not. The route is the shared JSON-record route; its hooks are driven directly.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { serviceStaffScope } from "@/lib/service/service-mode";
import type { PortalWorkspace } from "@/lib/workspaces/types";

const mocks = vi.hoisted(() => ({
  config: null as null | Record<string, unknown>,
  canWrite: vi.fn(),
  projected: [] as Record<string, unknown>[],
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
  linkedOwnerScopeForModule: vi.fn().mockResolvedValue({ ownerIds: new Set(), propertyIds: new Set(), propertyIdsByOwner: new Map() }),
}));
vi.mock("@/lib/schedule-record-projection.server", () => ({
  PARTNER_INQUIRIES_RECORD_ID: "axis_admin_partner_inquiries_v1",
  PLANNED_EVENTS_RECORD_ID: "axis_admin_planned_events_v1",
  // The ordinary projection keeps only rows the viewer wrote: what the owner's block never was.
  projectScheduleRecordsForViewer: vi.fn(async (_db: unknown, user: { id: string }, records: Record<string, unknown>[]) =>
    records.filter((record) => record.manager_user_id === user.id),
  ),
}));

await import("@/app/api/portal-schedule-records/route");

type Hook = (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
const hook = (name: string) => mocks.config![name] as Hook;

const OWNER = "ambika";
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

/** A thenable query that records its filters; the staff read (a record_type filter) answers with the owner's block. */
function fakeDb() {
  const calls: Array<{ table: string; ins: Record<string, unknown> }> = [];
  return {
    calls,
    from(table: string) {
      const rec = { table, ins: {} as Record<string, unknown> };
      calls.push(rec);
      const query: Record<string, unknown> = {};
      for (const name of ["select", "neq", "order", "limit", "eq", "or"]) query[name] = () => query;
      query.in = (column: string, values: unknown) => {
        rec.ins[column] = values;
        return query;
      };
      query.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ data: rec.ins.record_type ? [ownerBlock] : [], error: null }).then(resolve);
      return query;
    },
  };
}

beforeEach(() => {
  mocks.canWrite.mockReset().mockResolvedValue(false);
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
