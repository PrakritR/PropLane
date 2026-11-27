/**
 * The shared planned-events container is one JSON row every manager can read and write. A task that names a house
 * or a teammate is a claim: left out at write (only that item) unless the caller is a trusted writer of the house
 * (owner, a seat with Calendar or Services edit on it, or the managed house's operator / staff whose seat reaches it)
 * and the assignee is on the caller's team or the house; and, if one is planted anyway, never shown to the house's people under the same rule.
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
const TASK_CO = "co-tasks-only";
const BARE_CO = "co-assigned-only";
const READ_CO = "co-calendar-read";
const HOUSE = "house-1";
const CLIENT = "client-1";
const OPERATOR = "operator-1";
const MANAGED = "house-m";
const PLANNED = "axis_admin_planned_events_v1";
const STAFF = { id: "staff-1", role: "manager", serviceScope: { propertyIds: [MANAGED] } };
const STAFF_2 = { id: "staff-2", role: "manager", serviceScope: { propertyIds: [MANAGED] } };
const STAFF_ELSEWHERE = { id: "staff-3", role: "manager", serviceScope: { propertyIds: ["house-other"] } };
const COMANAGER = { id: "co-1", role: "manager" };
const OWNER_USER = { id: OWNER, role: "manager" };
const CLIENT_USER = { id: CLIENT, role: "manager" };

const tables = (): Record<string, Row[]> => ({
  manager_property_records: [
    { id: HOUSE, manager_user_id: OWNER, workspace_id: "ws-1" },
    { id: MANAGED, manager_user_id: CLIENT, workspace_id: "ws-m" },
  ],
  portal_workspaces: [
    { id: "ws-1", owner_user_id: OWNER, is_default: true, is_service: false },
    { id: "ws-m", owner_user_id: OPERATOR, is_default: false, is_service: true },
  ],
  account_link_invites: [
    {
      inviter_user_id: OWNER,
      invitee_user_id: CO_HOST,
      status: "accepted",
      assigned_property_ids: [HOUSE],
      property_co_manager_permissions: { [HOUSE]: { calendar: { read: true, edit: true } } },
    },
    {
      inviter_user_id: OWNER,
      invitee_user_id: TASK_CO,
      status: "accepted",
      assigned_property_ids: [HOUSE],
      property_co_manager_permissions: { [HOUSE]: { services: { read: true, edit: true } } },
    },
    {
      inviter_user_id: OWNER,
      invitee_user_id: BARE_CO,
      status: "accepted",
      assigned_property_ids: [HOUSE],
      property_co_manager_permissions: { [HOUSE]: {} },
    },
    {
      inviter_user_id: OWNER,
      invitee_user_id: READ_CO,
      status: "accepted",
      assigned_property_ids: [HOUSE],
      property_co_manager_permissions: { [HOUSE]: { calendar: { read: true } } },
    },
    ...[STAFF, STAFF_2, STAFF_ELSEWHERE].map((user) => ({
      inviter_user_id: OPERATOR,
      invitee_user_id: user.id,
      workspace_id: "ws-m",
      team_role: "full",
      is_service_seat: true,
      status: "accepted",
      house_scope: "selected",
      assigned_property_ids: user.serviceScope.propertyIds,
    })),
  ],
  platform_service_settings: [{ singleton: true, owner_user_id: OPERATOR }],
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
    expect(await visible(STAFF, [task("planted-m", ATTACKER, { propertyId: MANAGED })])).toEqual([]);
    expect(await visible(COMANAGER, [planted])).toEqual([]);
  });
  it("the writer still sees their own item", async () => {
    expect(await visible({ id: ATTACKER, role: "manager" }, [planted])).toEqual(["planted"]);
  });
  it("tasks by the owner or a seat with Calendar or Services edit on the house reach its people", async () => {
    const rows = [
      task("by-owner", OWNER, { propertyId: HOUSE }),
      task("by-host", CO_HOST, { propertyId: HOUSE }),
      task("by-task-co", TASK_CO, { propertyId: HOUSE, assignee: { type: "team", id: TASK_CO } }),
    ];
    expect(await visible(OWNER_USER, rows)).toEqual(["by-owner", "by-host", "by-task-co"]);
    expect(await visible(COMANAGER, rows)).toEqual(["by-owner", "by-host", "by-task-co"]);
    expect(await visible({ id: TASK_CO, role: "manager" }, rows)).toEqual(["by-owner", "by-host", "by-task-co"]);
  });
  it("a staff member's item on a managed house reaches its owner and the other staff", async () => {
    const rows = [task("by-staff", STAFF.id, { propertyId: MANAGED })];
    expect(await visible(STAFF_2, rows)).toEqual(["by-staff"]);
    expect(await visible(CLIENT_USER, rows)).toEqual(["by-staff"]);
  });
  it("an item by a seat with only an assignment or Calendar read on the house is hidden from its people", async () => {
    const rows = [task("by-bare", BARE_CO, { propertyId: HOUSE }), task("by-reader", READ_CO, { propertyId: HOUSE })];
    expect(await visible(OWNER_USER, rows)).toEqual([]);
    expect(await visible(COMANAGER, rows)).toEqual([]);
  });
  it("an item by staff whose own seat does not reach the managed house is hidden from its owner and staff", async () => {
    const rows = [task("by-elsewhere", STAFF_ELSEWHERE.id, { propertyId: MANAGED })];
    expect(await visible(CLIENT_USER, rows)).toEqual([]);
    expect(await visible(STAFF, rows)).toEqual([]);
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
  const written = () => (mocks.replace.mock.calls.at(-1)?.[1] as { events: Row[] }).events.map((item) => item.id);

  it("leaves out a stranger's task naming the victim's house and assignee", async () => {
    const result = await write({ id: ATTACKER, role: "manager" }, [
      task("x", ATTACKER, { propertyId: HOUSE, assignee: { type: "team", id: OWNER } }),
    ]);
    expect(result).toEqual({ handled: true });
    expect(written()).toEqual([]);
  });
  it("leaves out a stranger assigning a house-less task to someone off their team", async () => {
    await write({ id: ATTACKER, role: "manager" }, [task("x", ATTACKER, { assignee: { type: "team", id: OWNER } })]);
    expect(written()).toEqual([]);
  });
  it("one refused item does not block the rest of the snapshot", async () => {
    const result = await write({ id: ATTACKER, role: "manager" }, [
      task("ok", ATTACKER),
      task("bad", ATTACKER, { propertyId: HOUSE }),
      task("ok-2", ATTACKER, { assignee: { type: "team", id: ATTACKER } }),
    ]);
    expect(result).toEqual({ handled: true });
    expect(written()).toEqual(["ok", "ok-2"]);
  });
  it("a refused change keeps the stored version", async () => {
    const stored = task("old", ATTACKER, { title: "kept" });
    await write({ id: ATTACKER, role: "manager" }, [{ ...stored, propertyId: HOUSE }], [stored]);
    const events = (mocks.replace.mock.calls.at(-1)?.[1] as { events: Row[] }).events;
    expect(events).toEqual([expect.objectContaining({ id: "old", title: "kept" })]);
    expect(events[0]).not.toHaveProperty("propertyId");
  });
  it("lets the owner assign a house-less task to their co-manager", async () => {
    await write(OWNER_USER, [task("g", OWNER, { start: "2026-12-01T10:00", assignee: { type: "team", id: CO_HOST } })]);
    expect(written()).toEqual(["g"]);
  });
  it("lets the owner assign a work-order task on the house to a co-manager holding only Services edit", async () => {
    await write(OWNER_USER, [task("wo", OWNER, { propertyId: HOUSE, assignee: { type: "team", id: TASK_CO } })]);
    expect(written()).toEqual(["wo"]);
  });
  it("lets a co-manager holding Services edit (no Calendar edit) plan a task on the house", async () => {
    await write({ id: TASK_CO, role: "manager" }, [task("t", TASK_CO, { propertyId: HOUSE, assignee: { type: "team", id: OWNER } })]);
    expect(written()).toEqual(["t"]);
  });
  it("leaves out a seat holding only an assignment or Calendar read on the house", async () => {
    await write({ id: BARE_CO, role: "manager" }, [task("b", BARE_CO, { propertyId: HOUSE, assignee: { type: "team", id: OWNER } })]);
    expect(written()).toEqual([]);
    await write({ id: READ_CO, role: "manager" }, [task("r", READ_CO, { propertyId: HOUSE })]);
    expect(written()).toEqual([]);
  });
  it("leaves out staff planning on a managed house their own seat does not reach", async () => {
    await write(STAFF_ELSEWHERE, [task("e", STAFF_ELSEWHERE.id, { propertyId: MANAGED })]);
    expect(written()).toEqual([]);
  });
  it("leaves out a co-manager assigning someone off their team and off the house", async () => {
    await write({ id: CO_HOST, role: "manager" }, [
      task("x", CO_HOST, { propertyId: HOUSE, assignee: { type: "team", id: ATTACKER } }),
    ]);
    expect(written()).toEqual([]);
  });
  it("lets service staff plan on a managed house and assign its owner", async () => {
    await write(STAFF, [task("s", STAFF.id, { propertyId: MANAGED, assignee: { type: "team", id: CLIENT } })]);
    expect(written()).toEqual(["s"]);
  });
  it("lets a manager keep personal events and self-assigned tasks with no house", async () => {
    await write({ id: ATTACKER, role: "manager" }, [
      task("p", ATTACKER),
      task("q", ATTACKER, { assignee: { type: "team", id: ATTACKER } }),
    ]);
    expect(written()).toEqual(["p", "q"]);
  });
  it("does not re-judge an unchanged stored item", async () => {
    const stored = task("old", ATTACKER, { propertyId: HOUSE, assignee: { type: "team", id: OWNER } });
    await write({ id: ATTACKER, role: "manager" }, [stored], [stored]);
    expect(written()).toEqual(["old"]);
  });
});
