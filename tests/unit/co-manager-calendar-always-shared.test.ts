/**
 * The shared calendar is always shared: there is no "Share availability with co-managers" opt-in.
 * Everyone who passes the existing access checks (property access, calendar read on the house,
 * same workspace classification) is returned with their availability; anyone who does not pass
 * them is not, whatever they have saved. Services and tasks availability rides on the same route
 * (inspections and move-in/out hours merged into tasks) and never touches the public booking route.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { expectedManagerScheduleRecordIds } from "@/lib/portal-schedule-record-scope";
import { managerKindAvailabilityStorageKey } from "@/lib/manager-availability-kinds";

type Row = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  userId: "owner-a",
  classifications: new Map<string, { kind: "normal" }>(),
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
        predicates.push((row) => (value === null ? row[column] == null : row[column] === value));
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
      then: (resolve: (value: { data: Row[]; error: null }) => unknown) =>
        Promise.resolve({
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
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: mocks.userId, email: "x@example.com" } } }) },
  }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => db }));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveAuthenticatedBusinessAccess: vi.fn(async () => ({ kind: "normal" })),
  resolveTestWorkspaceClassification: vi.fn(async () => ({ kind: "normal" })),
}));
vi.mock("@/lib/auth/manager-lease-scope", () => ({
  managerHasCalendarAccessForProperty: vi.fn(async () => true),
}));

import { GET } from "@/app/api/portal/co-manager-calendar/route";

const OWNER = "owner-a";
const PEER = "co-manager-b";
const BLIND = "co-manager-c";
const PROPERTY = "property-a";
const KIND_TYPE = "manager_kind_availability";

type PeerBody = {
  userId: string;
  slots: string[];
  kindSlots: { services: string[]; tasks: string[] };
  sharesAvailability?: unknown;
};

function invite(invitee: string, permissions: Record<string, unknown>): Row {
  return {
    inviter_user_id: OWNER,
    invitee_user_id: invitee,
    assigned_property_ids: [PROPERTY],
    property_co_manager_permissions: { [PROPERTY]: permissions },
    status: "accepted",
    test_workspace_id: null,
  };
}

async function load(as: string): Promise<{ status: number; peers: PeerBody[] }> {
  mocks.userId = as;
  const response = await GET(new Request(`http://localhost/api/portal/co-manager-calendar?propertyId=${PROPERTY}`));
  const body = (await response.json()) as { peers?: PeerBody[] };
  return { status: response.status, peers: body.peers ?? [] };
}

beforeEach(() => {
  mocks.userId = OWNER;
  mocks.tables = {
    manager_property_records: [{ id: PROPERTY, manager_user_id: OWNER, property_data: {}, test_workspace_id: null }],
    account_link_invites: [
      invite(PEER, { calendar: { read: true } }),
      // Assigned to the house, but holds no calendar grant: "assigning a property is not a grant".
      invite(BLIND, { leases: { read: true } }),
    ],
    portal_schedule_records: [],
  };
});

describe("availability is always shared", () => {
  it("returns a permitted peer with their hours although they never opted in", async () => {
    const owner = expectedManagerScheduleRecordIds(OWNER, PROPERTY);
    const peer = expectedManagerScheduleRecordIds(PEER, PROPERTY);
    mocks.tables.portal_schedule_records = [
      // An old opt-out is simply ignored: nothing reads calendar_share_settings any more.
      {
        id: peer.shareKey,
        manager_user_id: PEER,
        record_type: "calendar_share_settings",
        row_data: { payload: { shareAvailability: false } },
        test_workspace_id: null,
      },
      { id: owner.availKey, manager_user_id: OWNER, row_data: { payload: ["2026-10-06:18"] }, test_workspace_id: null },
      { id: peer.availKey, manager_user_id: PEER, row_data: { payload: ["2026-10-06:20", "2026-10-06:21"] }, test_workspace_id: null },
    ];

    const result = await load(OWNER);

    expect(result.status).toBe(200);
    expect(result.peers.map((p) => p.userId).sort()).toEqual([OWNER, PEER].sort());
    expect(result.peers.find((p) => p.userId === PEER)?.slots).toEqual(["2026-10-06:20", "2026-10-06:21"]);
    expect(result.peers.find((p) => p.userId === OWNER)?.slots).toEqual(["2026-10-06:18"]);
    // There is no sharing flag to read back.
    expect(result.peers.every((p) => p.sharesAvailability === undefined)).toBe(true);
  });

  it("keeps a peer without calendar read out, and never serves their saved hours", async () => {
    const blind = expectedManagerScheduleRecordIds(BLIND, PROPERTY);
    mocks.tables.portal_schedule_records = [
      { id: blind.availKey, manager_user_id: BLIND, row_data: { payload: ["2026-10-06:30"] }, test_workspace_id: null },
      {
        id: managerKindAvailabilityStorageKey(BLIND, "services"),
        manager_user_id: BLIND,
        record_type: KIND_TYPE,
        row_data: { payload: ["2026-10-06:30"] },
        test_workspace_id: null,
      },
    ];

    const result = await load(OWNER);

    expect(result.peers.map((p) => p.userId)).not.toContain(BLIND);
    expect(JSON.stringify(result.peers)).not.toContain("2026-10-06:30");
  });

  it("still refuses a viewer who holds no calendar grant on the house", async () => {
    const result = await load(BLIND);
    expect(result.status).toBe(403);
    expect(result.peers).toEqual([]);
  });

  it("refuses a viewer whose grant is empty (no permissions = no access)", async () => {
    mocks.tables.account_link_invites = [invite(BLIND, {})];
    const result = await load(BLIND);
    expect(result.status).toBe(403);
  });
});

describe("services and tasks availability of everyone", () => {
  it("returns a peer's kind hours, with inspection and move hours merged into tasks", async () => {
    const day = "2026-10-07";
    const kindRow = (userId: string, kind: "services" | "tasks" | "inspections" | "moves", slots: string[]): Row => ({
      id: managerKindAvailabilityStorageKey(userId, kind),
      manager_user_id: userId,
      record_type: KIND_TYPE,
      row_data: { payload: slots },
      test_workspace_id: null,
    });
    mocks.tables.portal_schedule_records = [
      kindRow(PEER, "services", [`${day}:18`]),
      kindRow(PEER, "tasks", [`${day}:20`]),
      kindRow(PEER, "inspections", [`${day}:22`]),
      kindRow(PEER, "moves", [`${day}:24`, `${day}:20`]),
    ];

    const result = await load(OWNER);
    const peer = result.peers.find((p) => p.userId === PEER)!;

    expect(peer.kindSlots.services).toEqual([`${day}:18`]);
    expect([...peer.kindSlots.tasks].sort()).toEqual([`${day}:20`, `${day}:22`, `${day}:24`]);
  });

  it("ignores a kind-keyed row that is not a kind-availability record, and a row owned by someone else", async () => {
    const day = "2026-10-07";
    mocks.tables.portal_schedule_records = [
      {
        id: managerKindAvailabilityStorageKey(PEER, "services"),
        manager_user_id: PEER,
        record_type: "manager_availability",
        row_data: { payload: [`${day}:18`] },
        test_workspace_id: null,
      },
      {
        id: managerKindAvailabilityStorageKey(PEER, "tasks"),
        manager_user_id: OWNER,
        record_type: KIND_TYPE,
        row_data: { payload: [`${day}:20`] },
        test_workspace_id: null,
      },
    ];

    const peer = (await load(OWNER)).peers.find((p) => p.userId === PEER)!;

    expect(peer.kindSlots).toEqual({ services: [], tasks: [] });
  });

  it("is never read by the public booking route", () => {
    const publicRoute = readFileSync("src/app/api/public/property-tour-availability/route.ts", "utf8");
    const tourServer = readFileSync("src/lib/tour-availability.server.ts", "utf8");
    for (const source of [publicRoute, tourServer]) {
      expect(source).not.toContain("manager_kind_availability");
      expect(source).not.toContain("manager-availability-kinds");
    }
  });
});
