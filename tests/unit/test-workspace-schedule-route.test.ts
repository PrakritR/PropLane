import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  classify: vi.fn(),
  feature: vi.fn(),
  serviceDb: vi.fn(),
  genericGet: vi.fn(),
  genericPost: vi.fn(),
  replaceSlice: vi.fn(),
}));

vi.mock("@/lib/portal-record-api", () => ({
  createJsonRecordRoute: () => ({ GET: mocks.genericGet, POST: mocks.genericPost }),
}));
vi.mock("@/lib/auth/portal-access", () => ({ getPortalAccessContext: mocks.access }));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  isTestWorkspaceFeatureEnabled: mocks.feature,
  resolveTestWorkspaceClassification: mocks.classify,
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: mocks.serviceDb }));
vi.mock("@/lib/planned-schedule-persistence.server", () => ({
  replaceManagerPlannedScheduleSlice: mocks.replaceSlice,
}));

import { GET, POST } from "@/app/api/portal-schedule-records/route";

const ACTOR = "co-manager-a";
const OWNER = "owner-a";
const CUSTOMER_OWNER = "customer-owner";
const WORKSPACE = "workspace-a";
const FOREIGN_WORKSPACE = "workspace-foreign";
const SINGLETON = "axis_admin_planned_events_v1";
const LINKED_PROPERTY = "property-linked";
const OWN_PROPERTY = "property-own";
const FOREIGN_PROPERTY = "property-foreign";
const CUSTOMER_PROPERTY = "property-customer";

type DbState = {
  plannedPayload: Record<string, unknown>[];
  ownedRows?: Record<string, unknown>[];
  grants?: Record<string, unknown>[];
  properties?: Record<string, unknown>[];
};

function matches(row: Record<string, unknown>, filters: Array<[string, unknown]>): boolean {
  return filters.every(([column, value]) => {
    if (Array.isArray(value)) return value.includes(row[column]);
    if (Array.isArray(value)) return value.map(String).includes(String(row[column] ?? ""));
    if (column === "status") return row.status === value;
    if (column === "workspace_id" || column === "test_workspace_id") {
      return row[column] === value;
    }
    if (column === "record_key") return row.record_key === value;
    if (column === "invitee_user_id") return row.invitee_user_id === value;
    if (column === "manager_user_id") return row.manager_user_id === value;
    if (column === "id") return row.id === value;
    return true;
  });
}

function makeDb(state: DbState) {
  const ownedRows = state.ownedRows ?? [];
  const deletedIds: string[] = [];
  const upsertedRows: Record<string, unknown>[] = [];
  const rowsFor = (table: string, filters: Array<[string, unknown]>) => {
    if (table === "portal_schedule_records") {
      return ownedRows.filter((row) => matches(row, filters));
    }
    if (table === "account_link_invites") {
      return (state.grants ?? []).filter((row) => matches(row, filters));
    }
    if (table === "manager_property_records") {
      return (state.properties ?? []).filter((row) => matches(row, filters));
    }
    return [];
  };

  return {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      let operation: "delete" | null = null;
      // Fluent Supabase test double: methods intentionally return this dynamic chain.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const builder: Record<string, any> = {
        select: vi.fn(() => builder),
        eq: vi.fn((column: string, value: unknown) => {
          filters.push([column, value]);
          return builder;
        }),
        in: vi.fn((column: string, values: unknown[]) => {
          filters.push([column, values]);
          return builder;
        }),
        order: vi.fn(() => builder),
        limit: vi.fn(() => builder),
        delete: vi.fn(() => {
          operation = "delete";
          return builder;
        }),
        update: vi.fn(() => builder),
        insert: vi.fn((row: Record<string, unknown>) => {
          upsertedRows.push(row);
          return Promise.resolve({ error: null });
        }),
        upsert: vi.fn((row: Record<string, unknown>) => {
          upsertedRows.push(row);
          return Promise.resolve({ error: null });
        }),
        maybeSingle: vi.fn(async () => {
          if (table === "test_workspace_schedule_records") {
            const workspaceId = filters.find(([column]) => column === "workspace_id")?.[1];
            const recordKey = filters.find(([column]) => column === "record_key")?.[1];
            if (workspaceId === WORKSPACE && recordKey === "planned_events") {
              return {
                data: {
                  row_data: { id: SINGLETON, recordType: SINGLETON, payload: state.plannedPayload },
                },
                error: null,
              };
            }
          }
          if (table === "portal_schedule_records") {
            const rows = rowsFor(table, filters);
            return { data: rows[0] ?? null, error: null };
          }
          return { data: null, error: null };
        }),
      };
      builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => {
        if (operation === "delete") {
          const deleted = rowsFor(table, filters);
          for (const row of deleted) {
            const id = String(row.id ?? "");
            if (id) deletedIds.push(id);
          }
          for (const row of deleted) {
            const index = ownedRows.indexOf(row);
            if (index >= 0) ownedRows.splice(index, 1);
          }
          return Promise.resolve({ data: deleted.map((row) => ({ id: row.id })), error: null }).then(resolve, reject);
        }
        return Promise.resolve({ data: rowsFor(table, filters), error: null }).then(resolve, reject);
      };
      return builder;
    },
    __deletedIds: deletedIds,
    __upsertedRows: upsertedRows,
  };
}

function request(body: unknown) {
  return new Request("https://prop-lane.test/api/portal-schedule-records", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function plannedUpsert(
  payload: Record<string, unknown>[],
  expectedPayload: Record<string, unknown>[] = [],
) {
  return request({
    action: "upsert",
    expectedPayloadKnown: true,
    expectedPayload,
    row: {
      id: SINGLETON,
      recordType: SINGLETON,
      payload,
    },
  });
}

function event(id: string, propertyId: string, managerUserId = OWNER) {
  return { id, propertyId, managerUserId, title: id };
}

function grant(
  propertyId: string,
  permissions: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return {
    status: "accepted",
    inviter_user_id: OWNER,
    invitee_user_id: ACTOR,
    assigned_property_ids: [propertyId],
    property_co_manager_permissions: permissions,
    test_workspace_id: WORKSPACE,
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.access.mockResolvedValue({ user: { id: ACTOR } });
  mocks.classify.mockResolvedValue({
    kind: "classified",
    workspaceId: WORKSPACE,
    role: "co_manager",
    state: "active",
  });
  mocks.feature.mockReturnValue(true);
  mocks.genericGet.mockResolvedValue(Response.json({ error: "generic route" }, { status: 418 }));
  mocks.genericPost.mockResolvedValue(Response.json({ error: "generic route" }, { status: 418 }));
  mocks.replaceSlice.mockResolvedValue({ available: true, ok: true, idempotent: false });
  mocks.serviceDb.mockImplementation(() => makeDb({ plannedPayload: [] }));
});

describe("private schedule writes fail closed before the customer record route", () => {
  it.each([
    ["delete", { action: "delete", id: SINGLETON }],
    ["deleteIds", { action: "deleteIds", ids: [SINGLETON, "customer-schedule-row"] }],
    ["replace", { action: "replace", rows: [{ id: "workspace-schedule-row", recordType: "event" }] }],
    ["malformed", { action: "replace", rows: "not-an-array" }],
    ["mixed", { action: "upsert", row: { id: SINGLETON }, rows: [{ id: "customer-row" }] }],
  ])("handles active test-workspace %s without generic customer delegation", async (_name, body) => {
    const response = await POST(request(body));

    expect(response.status).not.toBe(418);
    expect(mocks.genericPost).not.toHaveBeenCalled();
  });

  it("allows an ordinary owned availability upsert in the workspace namespace", async () => {
    const db = makeDb({
      plannedPayload: [],
      ownedRows: [],
      properties: [{ id: LINKED_PROPERTY, test_workspace_id: WORKSPACE, manager_user_id: ACTOR }],
    });
    mocks.serviceDb.mockReturnValue(db);

    const response = await POST(request({
      action: "upsert",
      row: {
        id: `axis_mgr_avail_slots_v2_${ACTOR}_prop_${LINKED_PROPERTY}`,
        recordType: "manager_property_availability",
        propertyId: LINKED_PROPERTY,
        slots: [],
      },
    }));

    expect(response.status).toBe(200);
    expect(mocks.genericPost).not.toHaveBeenCalled();
    expect(db.__upsertedRows).toHaveLength(1);
  });

  it("allows deleting an ordinary row that is already owned by this workspace actor", async () => {
    const db = makeDb({
      plannedPayload: [],
      ownedRows: [{
        id: `axis_manager_tasks_v1_${ACTOR}`,
        manager_user_id: ACTOR,
        test_workspace_id: WORKSPACE,
        record_type: "manager_tasks",
        row_data: { id: `axis_manager_tasks_v1_${ACTOR}`, recordType: "manager_tasks" },
      }],
    });
    mocks.serviceDb.mockReturnValue(db);

    const response = await POST(request({ action: "delete", id: `axis_manager_tasks_v1_${ACTOR}` }));

    expect(response.status).toBe(200);
    expect(mocks.genericPost).not.toHaveBeenCalled();
    expect(db.__deletedIds).toEqual([`axis_manager_tasks_v1_${ACTOR}`]);
  });

  it.each([
    ["the planned-events singleton", SINGLETON],
    ["the partner-inquiries singleton", "axis_admin_partner_inquiries_v1"],
  ])("rejects deleting %s", async (_label, id) => {
    const db = makeDb({ plannedPayload: [], ownedRows: [{ id, manager_user_id: ACTOR, test_workspace_id: WORKSPACE }] });
    mocks.serviceDb.mockReturnValue(db);

    const response = await POST(request({ action: "delete", id }));

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(mocks.genericPost).not.toHaveBeenCalled();
    expect(db.__deletedIds).toHaveLength(0);
  });

  it("rejects a foreign-workspace delete and a mixed deleteIds batch atomically", async () => {
    const db = makeDb({
      plannedPayload: [],
      ownedRows: [
        { id: "workspace-task-1", manager_user_id: ACTOR, test_workspace_id: WORKSPACE },
        { id: "foreign-task-1", manager_user_id: ACTOR, test_workspace_id: FOREIGN_WORKSPACE },
      ],
    });
    mocks.serviceDb.mockReturnValue(db);

    const foreign = await POST(request({ action: "delete", id: "foreign-task-1" }));
    expect(foreign.status).toBeGreaterThanOrEqual(400);
    expect(foreign.status).toBeLessThan(500);
    expect(db.__deletedIds).toHaveLength(0);

    const mixed = await POST(request({ action: "deleteIds", ids: ["workspace-task-1", "foreign-task-1"] }));
    expect(mixed.status).toBeGreaterThanOrEqual(400);
    expect(mixed.status).toBeLessThan(500);
    expect(db.__deletedIds).toHaveLength(0);
    expect(mocks.genericPost).not.toHaveBeenCalled();
  });
});

describe("co-manager schedule visibility and property provenance", () => {
  const own = event("own-event", OWN_PROPERTY, ACTOR);
  const linked = event("linked-event", LINKED_PROPERTY);
  const unrelated = event("unrelated-event", "property-unrelated");
  const revoked = event("revoked-event", "property-revoked");

  async function load(grants: Record<string, unknown>[]) {
    const db = makeDb({
      plannedPayload: [own, linked, unrelated, revoked],
      grants,
      properties: [
        { id: OWN_PROPERTY, test_workspace_id: WORKSPACE, manager_user_id: ACTOR },
        { id: LINKED_PROPERTY, test_workspace_id: WORKSPACE, manager_user_id: OWNER },
        { id: "property-unrelated", test_workspace_id: WORKSPACE, manager_user_id: OWNER },
        { id: "property-revoked", test_workspace_id: WORKSPACE, manager_user_id: OWNER },
      ],
    });
    mocks.serviceDb.mockReturnValue(db);
    const response = await GET();
    const body = await response.json();
    return body.rows[0].payload as Record<string, unknown>[];
  }

  it("keeps direct owner access while empty, unrelated, and revoked links see no assigned events", async () => {
    const rows = await load([
      grant(LINKED_PROPERTY, {}),
      grant("property-unrelated", { inbox: { read: true } }),
      grant("property-revoked", { calendar: { read: true } }, { status: "revoked" }),
    ]);

    expect(rows.map((row) => row.id)).toEqual([own.id]);
  });

  it.each([
    ["read", { calendar: { read: true } }],
    ["edit", { calendar: { read: true, edit: true } }],
  ])("allows a linked event with an explicit calendar %s grant", async (_level, permissions) => {
    const rows = await load([grant(LINKED_PROPERTY, permissions)]);
    expect(rows.map((row) => row.id)).toEqual([own.id, linked.id]);
    expect(rows.map((row) => row.id)).not.toContain(unrelated.id);
  });

  it.each([
    [CUSTOMER_PROPERTY, null, CUSTOMER_OWNER],
    [FOREIGN_PROPERTY, FOREIGN_WORKSPACE, OWNER],
  ])("rejects a schedule event attached to a %s property", async (propertyId, workspaceId, managerUserId) => {
    mocks.serviceDb.mockImplementation(() => makeDb({
      plannedPayload: [],
      grants: [grant(LINKED_PROPERTY, { calendar: { read: true, edit: true } })],
      properties: [{ id: propertyId, test_workspace_id: workspaceId, manager_user_id: managerUserId }],
    }));

    const response = await POST(plannedUpsert([event(`bad-${propertyId}`, propertyId, ACTOR)]));

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(mocks.replaceSlice).not.toHaveBeenCalled();
  });
});

describe("planned-event replacement reconciles the actor slice", () => {
  it("accepts an unchanged linked-owner cache row with a new actor event", async () => {
    const linked = event("linked-event", LINKED_PROPERTY, OWNER);
    const added = event("actor-added", OWN_PROPERTY, ACTOR);
    const db = makeDb({
      plannedPayload: [linked],
      grants: [grant(LINKED_PROPERTY, { calendar: { read: true } })],
      properties: [
        { id: LINKED_PROPERTY, test_workspace_id: WORKSPACE, manager_user_id: OWNER },
        { id: OWN_PROPERTY, test_workspace_id: WORKSPACE, manager_user_id: ACTOR },
      ],
    });
    mocks.serviceDb.mockReturnValue(db);

    const response = await POST(plannedUpsert([linked, added]));

    expect(response.status).toBe(200);
    expect(mocks.replaceSlice).toHaveBeenCalledTimes(1);
    const [, args] = mocks.replaceSlice.mock.calls[0] as [unknown, {
      managerUserId: string;
      testWorkspaceId: string;
      events: Record<string, unknown>[];
      expectedEvents: Record<string, unknown>[];
    }];
    expect(args.managerUserId).toBe(ACTOR);
    expect(args.testWorkspaceId).toBe(WORKSPACE);
    expect(args.events).toEqual([expect.objectContaining({ id: added.id, managerUserId: ACTOR })]);
    expect(args.expectedEvents).toEqual([]);
    expect(args.events.some((row) => row.id === linked.id)).toBe(false);
    expect(args.expectedEvents.some((row) => row.id === linked.id)).toBe(false);
  });

  it("rejects an attempted alteration of a linked-owner event", async () => {
    const linked = event("linked-event", LINKED_PROPERTY, OWNER);
    const db = makeDb({
      plannedPayload: [linked],
      grants: [grant(LINKED_PROPERTY, { calendar: { read: true, edit: true } })],
      properties: [{ id: LINKED_PROPERTY, test_workspace_id: WORKSPACE, manager_user_id: OWNER }],
    });
    mocks.serviceDb.mockReturnValue(db);

    const response = await POST(plannedUpsert([{ ...linked, title: "changed by actor" }]));

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(mocks.replaceSlice).not.toHaveBeenCalled();
  });

  it("preserves an unchanged actor event when the actor only has read access", async () => {
    const readOnly = event("read-only-actor-event", LINKED_PROPERTY, ACTOR);
    const db = makeDb({
      plannedPayload: [readOnly],
      grants: [grant(LINKED_PROPERTY, { calendar: { read: true } })],
      properties: [{ id: LINKED_PROPERTY, test_workspace_id: WORKSPACE, manager_user_id: OWNER }],
    });
    mocks.serviceDb.mockReturnValue(db);

    const response = await POST(plannedUpsert([readOnly], [readOnly]));

    expect(response.status).toBe(200);
    expect(mocks.replaceSlice).toHaveBeenCalledTimes(1);
    const [, args] = mocks.replaceSlice.mock.calls[0] as [unknown, {
      events: Record<string, unknown>[];
      expectedEvents: Record<string, unknown>[];
    }];
    expect(args.events).toEqual([expect.objectContaining({ id: readOnly.id, managerUserId: ACTOR })]);
    expect(args.expectedEvents).toEqual([expect.objectContaining({ id: readOnly.id, managerUserId: ACTOR })]);
  });

  it("rejects a modification of an actor event when the actor only has read access", async () => {
    const readOnly = event("read-only-actor-event", LINKED_PROPERTY, ACTOR);
    const db = makeDb({
      plannedPayload: [readOnly],
      grants: [grant(LINKED_PROPERTY, { calendar: { read: true } })],
      properties: [{ id: LINKED_PROPERTY, test_workspace_id: WORKSPACE, manager_user_id: OWNER }],
    });
    mocks.serviceDb.mockReturnValue(db);

    const response = await POST(plannedUpsert([{ ...readOnly, title: "changed by actor" }], [readOnly]));

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(mocks.replaceSlice).not.toHaveBeenCalled();
  });

  it("keeps a revoked hidden actor event when the client omits it from its cache", async () => {
    const revoked = event("revoked-hidden-event", LINKED_PROPERTY, ACTOR);
    const db = makeDb({
      plannedPayload: [revoked],
      grants: [],
      properties: [{ id: LINKED_PROPERTY, test_workspace_id: WORKSPACE, manager_user_id: OWNER }],
    });
    mocks.serviceDb.mockReturnValue(db);

    const response = await POST(plannedUpsert([]));

    expect(response.status).toBe(200);
    expect(mocks.replaceSlice).toHaveBeenCalledTimes(1);
    const [, args] = mocks.replaceSlice.mock.calls[0] as [unknown, {
      events: Record<string, unknown>[];
      expectedEvents: Record<string, unknown>[];
    }];
    expect(args.events).toEqual([expect.objectContaining({ id: revoked.id, managerUserId: ACTOR })]);
    expect(args.expectedEvents).toEqual([expect.objectContaining({ id: revoked.id, managerUserId: ACTOR })]);
  });

  it.each([
    ["changes", { id: "revoked-hidden-event", managerUserId: ACTOR, propertyId: OWN_PROPERTY, title: "moved" }],
    ["drops", { id: "revoked-hidden-event", managerUserId: ACTOR, title: "property omitted" }],
  ])("rejects a revoked hidden actor event when the client %s its property", async (_label, attempted) => {
    const revoked = event("revoked-hidden-event", LINKED_PROPERTY, ACTOR);
    const db = makeDb({
      plannedPayload: [revoked],
      grants: [],
      properties: [
        { id: LINKED_PROPERTY, test_workspace_id: WORKSPACE, manager_user_id: OWNER },
        { id: OWN_PROPERTY, test_workspace_id: WORKSPACE, manager_user_id: ACTOR },
      ],
    });
    mocks.serviceDb.mockReturnValue(db);

    const response = await POST(plannedUpsert([attempted]));

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(mocks.replaceSlice).not.toHaveBeenCalled();
  });

  it("allows an authorized actor to remove one event and add another", async () => {
    const existing = event("existing-actor-event", OWN_PROPERTY, ACTOR);
    const added = event("added-actor-event", OWN_PROPERTY, ACTOR);
    const db = makeDb({
      plannedPayload: [existing],
      properties: [{ id: OWN_PROPERTY, test_workspace_id: WORKSPACE, manager_user_id: ACTOR }],
    });
    mocks.serviceDb.mockReturnValue(db);

    const response = await POST(plannedUpsert([added], [existing]));

    expect(response.status).toBe(200);
    expect(mocks.replaceSlice).toHaveBeenCalledTimes(1);
    const [, args] = mocks.replaceSlice.mock.calls[0] as [unknown, {
      events: Record<string, unknown>[];
      expectedEvents: Record<string, unknown>[];
    }];
    expect(args.events).toEqual([expect.objectContaining({ id: added.id, managerUserId: ACTOR })]);
    expect(args.expectedEvents).toEqual([expect.objectContaining({ id: existing.id, managerUserId: ACTOR })]);
  });

  it("passes the client-observed baseline instead of substituting a newer server snapshot", async () => {
    const observed = event("actor-event", OWN_PROPERTY, ACTOR);
    const current = { ...observed, title: "changed in another tab" };
    const submitted = { ...observed, title: "stale tab change" };
    mocks.serviceDb.mockReturnValue(makeDb({
      plannedPayload: [current],
      properties: [{ id: OWN_PROPERTY, test_workspace_id: WORKSPACE, manager_user_id: ACTOR }],
    }));

    const response = await POST(plannedUpsert([submitted], [observed]));

    expect(response.status).toBe(200);
    const [, args] = mocks.replaceSlice.mock.calls[0] as [unknown, {
      expectedEvents: Record<string, unknown>[];
    }];
    expect(args.expectedEvents).toEqual([observed]);
    expect(args.expectedEvents).not.toEqual([current]);
  });

  it("rejects planned-event replacement without an observed baseline", async () => {
    mocks.serviceDb.mockReturnValue(makeDb({ plannedPayload: [] }));
    const response = await POST(request({
      action: "upsert",
      row: { id: SINGLETON, recordType: SINGLETON, payload: [] },
    }));
    expect(response.status).toBe(409);
    expect(mocks.replaceSlice).not.toHaveBeenCalled();
  });
});
