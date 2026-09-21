import { beforeEach, describe, expect, it, vi } from "vitest";
import { expectedManagerScheduleRecordIds } from "@/lib/portal-schedule-record-scope";

type Row = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  access: { kind: "test", workspaceId: "workspace-a" } as
    | { kind: "normal" }
    | { kind: "test"; workspaceId: string }
    | { kind: "denied" },
  classifications: new Map<string, { kind: "normal" } | { kind: "classified"; workspaceId: string; role: "manager" | "co_manager" | "resident"; state: "active" | "suspended" | "expired" }>(),
  normalCalendarAccess: vi.fn(),
}));

function makeDb() {
  const from = (table: string) => {
    const predicates: Array<(row: Row) => boolean> = [];
    const query: Record<string, unknown> = {
      select: () => query,
      eq: (column: string, value: unknown) => {
        predicates.push((row) => String(row[column] ?? "") === String(value));
        return query;
      },
      is: (column: string, value: unknown) => {
        predicates.push((row) => value === null ? row[column] == null : row[column] === value);
        return query;
      },
      in: (column: string, values: unknown[]) => {
        const allowed = new Set(values.map(String));
        predicates.push((row) => allowed.has(String(row[column] ?? "")));
        return query;
      },
      or: () => query,
      order: () => query,
      limit: () => query,
      maybeSingle: async () => ({
        data: (mocks.tables[table] ?? []).find((row) => predicates.every((predicate) => predicate(row))) ?? null,
        error: null,
      }),
      then: (resolve: (value: { data: Row[]; error: null }) => unknown) => Promise.resolve({
        data: (mocks.tables[table] ?? []).filter((row) => predicates.every((predicate) => predicate(row))),
        error: null,
      }).then(resolve),
    };
    return query;
  };
  return { from };
}

const db = makeDb();

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "resident-a", email: "resident@example.com" } } }) } }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => db }));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveAuthenticatedBusinessAccess: vi.fn(async () => mocks.access),
  resolveTestWorkspaceClassification: vi.fn(async (userId: string) => mocks.classifications.get(userId) ?? { kind: "normal" }),
}));
vi.mock("@/lib/auth/manager-lease-scope", () => ({
  managerHasCalendarAccessForProperty: (...args: unknown[]) => mocks.normalCalendarAccess(...args),
}));

import { GET as getCalendar } from "@/app/api/portal/co-manager-calendar/route";
import { GET as getResidentProperty } from "@/app/api/portal/resident-property/route";

const OWNER = "owner-a";
const PEER = "resident-a";
const PROPERTY = "property-a";

describe("private workspace read namespaces", () => {
  beforeEach(() => {
    mocks.tables = {};
    mocks.access = { kind: "test", workspaceId: "workspace-a" };
    mocks.classifications.clear();
    mocks.classifications.set(OWNER, { kind: "classified", workspaceId: "workspace-a", role: "manager", state: "active" });
    mocks.classifications.set(PEER, { kind: "classified", workspaceId: "workspace-a", role: "resident", state: "active" });
    mocks.normalCalendarAccess.mockReset();
    mocks.normalCalendarAccess.mockRejectedValue(new Error("normal calendar resolver must not run for private scope"));
  });

  it("loads co-manager availability only from the active private workspace and drops a normal peer", async () => {
    const { shareKey, availKey } = expectedManagerScheduleRecordIds(OWNER, PROPERTY);
    const peerIds = expectedManagerScheduleRecordIds(PEER, PROPERTY);
    mocks.tables.manager_property_records = [{ id: PROPERTY, manager_user_id: OWNER, property_data: {}, test_workspace_id: "workspace-a" }];
    mocks.tables.account_link_invites = [
      {
        inviter_user_id: OWNER,
        invitee_user_id: PEER,
        assigned_property_ids: [PROPERTY],
        property_co_manager_permissions: { [PROPERTY]: { calendar: true } },
        status: "accepted",
        test_workspace_id: "workspace-a",
      },
      {
        inviter_user_id: OWNER,
        invitee_user_id: "normal-peer",
        assigned_property_ids: [PROPERTY],
        property_co_manager_permissions: { [PROPERTY]: { calendar: true } },
        status: "accepted",
        test_workspace_id: "workspace-a",
      },
    ];
    mocks.tables.portal_schedule_records = [
      { id: shareKey, manager_user_id: OWNER, row_data: { payload: { shareAvailability: true } }, test_workspace_id: "workspace-a" },
      { id: availKey, manager_user_id: OWNER, row_data: { payload: ["private-slot"] }, test_workspace_id: "workspace-a" },
      { id: peerIds.availKey, manager_user_id: PEER, row_data: { payload: ["self-slot"] }, test_workspace_id: "workspace-a" },
      { id: availKey, manager_user_id: OWNER, row_data: { payload: ["ordinary-slot"] }, test_workspace_id: null },
    ];

    const response = await getCalendar(new Request(`http://localhost/api/portal/co-manager-calendar?propertyId=${PROPERTY}`));
    const body = await response.json() as { peers: Array<{ userId: string; slots: string[] }> };

    expect(response.status).toBe(200);
    expect(body.peers.map((peer) => peer.userId).sort()).toEqual([OWNER, PEER].sort());
    expect(body.peers.find((peer) => peer.userId === OWNER)?.slots).toEqual(["private-slot"]);
    expect(body.peers.find((peer) => peer.userId === PEER)?.slots).toEqual(["self-slot"]);
    expect(mocks.normalCalendarAccess).not.toHaveBeenCalled();
  });

  it("hydrates a resident only from a same-workspace application, manager, and property", async () => {
    mocks.tables.profiles = [{ id: PEER, email: "resident@example.com" }];
    mocks.tables.manager_application_records = [
      {
        id: "private-app",
        resident_email: "resident@example.com",
        manager_user_id: OWNER,
        property_id: PROPERTY,
        row_data: { bucket: "approved", propertyId: PROPERTY },
        updated_at: "2026-09-19T12:00:00.000Z",
        test_workspace_id: "workspace-a",
      },
      {
        id: "ordinary-app",
        resident_email: "resident@example.com",
        manager_user_id: "normal-owner",
        property_id: "ordinary-property",
        row_data: { bucket: "approved", propertyId: "ordinary-property" },
        updated_at: "2026-09-19T13:00:00.000Z",
        test_workspace_id: null,
      },
    ];
    mocks.tables.manager_property_records = [
      {
        id: PROPERTY,
        manager_user_id: OWNER,
        status: "draft",
        property_data: { id: PROPERTY, title: "Private home" },
        test_workspace_id: "workspace-a",
      },
      {
        id: "ordinary-property",
        manager_user_id: "normal-owner",
        status: "live",
        property_data: { id: "ordinary-property", title: "Ordinary home" },
        test_workspace_id: null,
      },
    ];

    const response = await getResidentProperty();
    const body = await response.json() as { property: { id: string; title: string }; managerUserId: string };

    expect(response.status).toBe(200);
    expect(body.property).toMatchObject({ id: PROPERTY, title: "Private home" });
    expect(body.managerUserId).toBe(OWNER);
  });
});
