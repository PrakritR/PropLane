/**
 * The shared planned-events container is one JSON row every manager can read and write. A task that names a house
 * or a teammate is a claim: refused at write unless the caller may plan on that house and may assign that person,
 * and, if one is planted anyway, never shown to the house's owner, staff or co-managers (the item's server-pinned
 * `managerUserId` must be the owner or an eligible host of that house).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  scope: vi.fn(),
  canWrite: vi.fn(),
  config: null as null | Record<string, unknown>,
  replace: vi.fn(),
}));
vi.mock("@/lib/auth/co-manager-module-scope", () => ({ linkedOwnerScopeForModule: mocks.scope }));
vi.mock("@/lib/auth/manager-lease-scope", () => ({ managerCanWriteCalendarForProperty: mocks.canWrite }));
vi.mock("@/lib/portal-record-api", () => ({
  createJsonRecordRoute: (config: Record<string, unknown>) => {
    mocks.config = config;
    return { GET: vi.fn(), POST: vi.fn() };
  },
}));
vi.mock("@/lib/planned-schedule-persistence.server", () => ({ replaceManagerPlannedScheduleSlice: mocks.replace }));
vi.mock("@/lib/workspaces/scope.server", () => ({ activeWorkspacePropertyScope: vi.fn().mockResolvedValue(null) }));

import { projectScheduleRecordsForViewer } from "@/lib/schedule-record-projection.server";

await import("@/app/api/portal-schedule-records/route");

type Row = Record<string, unknown>;
const OWNER = "owner-1";
const ATTACKER = "attacker-1";
const CO_HOST = "co-host-b";
const HOUSE = "house-1";
const PLANNED = "axis_admin_planned_events_v1";
const STAFF = { id: "staff-1", role: "manager", serviceScope: { propertyIds: [HOUSE] } };
const COMANAGER = { id: "co-1", role: "manager" };
const OWNER_USER = { id: OWNER, role: "manager" };

const tables = (): Record<string, Row[]> => ({
  manager_property_records: [{ id: HOUSE, manager_user_id: OWNER, workspace_id: "ws-1" }],
  portal_workspaces: [{ id: "ws-1", owner_user_id: OWNER, is_default: true, is_service: false }],
  account_link_invites: [
    {
      inviter_user_id: OWNER,
      invitee_user_id: CO_HOST,
      status: "accepted",
      assigned_property_ids: [HOUSE],
      property_co_manager_permissions: { [HOUSE]: { calendar: { read: true, edit: true } } },
    },
  ],
  platform_service_settings: [{ singleton: true, owner_user_id: "operator-1" }],
});

const db = {
  from(table: string) {
    const filters: Array<(row: Row) => boolean> = [];
    const answer = () => ({ data: (tables()[table] ?? []).filter((row) => filters.every((f) => f(row))), error: null });
    const q: Record<string, unknown> = {
      select: () => q,
      in: (column: string, values: unknown[]) => (filters.push((row) => values.includes(row[column])), q),
      eq: (column: string, value: unknown) => (filters.push((row) => row[column] === value), q),
      maybeSingle: async () => ({ data: answer().data[0] ?? null, error: null }),
      then: (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) =>
        Promise.resolve(answer()).then(resolve, reject),
    };
    return q;
  },
} as never;

const container = (payload: Row[]) => ({ id: PLANNED, row_data: { id: PLANNED, payload } });
const task = (id: string, writer: string, extra: Row = {}) => ({ id, kind: "task", managerUserId: writer, title: "T", ...extra });
const visible = async (user: Row, payload: Row[]) => {
  const [out] = await projectScheduleRecordsForViewer(db, user as never, [container(payload)]);
  return ((out.row_data as { payload: Row[] }).payload).map((item) => item.id);
};

beforeEach(() => {
  mocks.scope.mockReset().mockResolvedValue({
    ownerIds: new Set(),
    propertyIds: new Set(),
    propertyIdsByOwner: new Map([[OWNER, new Set([HOUSE])]]),
  });
  mocks.canWrite.mockReset().mockImplementation(async (_db: unknown, userId: string, house: string) =>
    house === HOUSE && (userId === OWNER || userId === CO_HOST),
  );
  mocks.replace.mockReset().mockResolvedValue({ available: true, ok: true, idempotent: false });
});

describe("planted planned-events task: projection", () => {
  const planted = task("planted", ATTACKER, { propertyId: HOUSE, assignee: { type: "team", id: COMANAGER.id } });
  it("is hidden from the owner, staff and a co-manager it names", async () => {
    expect(await visible(OWNER_USER, [planted])).toEqual([]);
    expect(await visible(STAFF, [planted])).toEqual([]);
    expect(await visible(COMANAGER, [planted])).toEqual([]);
  });
  it("the writer still sees their own item", async () => {
    expect(await visible({ id: ATTACKER, role: "manager" }, [planted])).toEqual(["planted"]);
  });
  it("tasks by the owner or an eligible host on the house still reach owner, staff and co-managers", async () => {
    const rows = [task("by-owner", OWNER, { propertyId: HOUSE }), task("by-host", CO_HOST, { propertyId: HOUSE })];
    expect(await visible(OWNER_USER, rows)).toEqual(["by-owner", "by-host"]);
    expect(await visible(STAFF, rows)).toEqual(["by-owner", "by-host"]);
    expect(await visible(COMANAGER, rows)).toEqual(["by-owner", "by-host"]);
  });
  it("a house-less item stays private to its writer", async () => {
    const mine = task("personal", ATTACKER);
    expect(await visible(OWNER_USER, [mine])).toEqual([]);
    expect(await visible({ id: ATTACKER, role: "manager" }, [mine])).toEqual(["personal"]);
  });
});

describe("planned-events task: write", () => {
  type AtomicWrite = (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  const write = (user: Row, payload: Row[], existing: Row[] = []) =>
    (mocks.config!.atomicWrite as AtomicWrite)({
      db,
      user,
      record: container(payload),
      existing: container(existing),
      expectedPayloadKnown: false,
      expectedPayload: null,
    });

  it("refuses a stranger's task naming the victim's house and assignee", async () => {
    const result = await write({ id: ATTACKER, role: "manager" }, [
      task("x", ATTACKER, { propertyId: HOUSE, assignee: { type: "team", id: OWNER } }),
    ]);
    expect(result).toMatchObject({ handled: true, status: 403 });
    expect(mocks.replace).not.toHaveBeenCalled();
  });
  it("refuses a stranger assigning a house-less task to someone else", async () => {
    const result = await write({ id: ATTACKER, role: "manager" }, [task("x", ATTACKER, { assignee: { type: "team", id: OWNER } })]);
    expect(result).toMatchObject({ handled: true, status: 403 });
  });
  it("refuses a co-manager assigning a teammate not on the house's team", async () => {
    const result = await write({ id: CO_HOST, role: "manager" }, [
      task("x", CO_HOST, { propertyId: HOUSE, assignee: { type: "team", id: ATTACKER } }),
    ]);
    expect(result).toMatchObject({ handled: true, status: 403 });
  });
  it("lets the owner and a co-manager with Calendar edit plan on the house and assign teammates", async () => {
    expect(await write(OWNER_USER, [task("a", OWNER, { propertyId: HOUSE, assignee: { type: "team", id: CO_HOST } })])).toEqual({ handled: true });
    expect(await write({ id: CO_HOST, role: "manager" }, [task("b", CO_HOST, { propertyId: HOUSE, assignee: { type: "team", id: OWNER } })])).toEqual({ handled: true });
    expect(mocks.replace).toHaveBeenCalledTimes(2);
  });
  it("lets service staff plan on a staffed house", async () => {
    expect(await write(STAFF, [task("s", STAFF.id, { propertyId: HOUSE, assignee: { type: "team", id: OWNER } })])).toEqual({ handled: true });
  });
  it("lets a manager keep personal events and self-assigned tasks with no house", async () => {
    expect(await write({ id: ATTACKER, role: "manager" }, [
      task("p", ATTACKER),
      task("q", ATTACKER, { assignee: { type: "team", id: ATTACKER } }),
    ])).toEqual({ handled: true });
  });
  it("does not re-judge an unchanged stored item", async () => {
    const stored = task("old", ATTACKER, { propertyId: HOUSE, assignee: { type: "team", id: OWNER } });
    expect(await write({ id: ATTACKER, role: "manager" }, [stored], [stored])).toEqual({ handled: true });
  });
});
