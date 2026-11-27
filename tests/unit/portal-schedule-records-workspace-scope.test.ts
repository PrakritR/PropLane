import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tours / bookings / calendar (`portal_schedule_records`, one table backing
 * several record kinds) never applied the active-workspace predicate: a
 * manager with two workspaces read and wrote rows across both from one
 * portal session. `activeWorkspacePropertyScope` is mocked directly here
 * (its own correctness is covered by `co-manager-workspace-scope-leak.test.ts`)
 * so these tests isolate exactly the new call sites in the route itself.
 */

import { tourCalendarOwnerRecordId } from "@/lib/google-calendar/tour-calendar-owner.server";

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  portal: {
    user: { id: "owner-a", email: "owner-a@example.test" },
    roles: ["manager"],
    effectiveRole: "manager",
    profile: { email: "owner-a@example.test", role: "manager" },
  } as Record<string, unknown>,
  admin: false,
  scheduleRows: [] as Row[],
  workspaceScope: null as string[] | null,
  scopeUnavailable: false,
}));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: (task: () => unknown) => void task() };
});
vi.mock("@/lib/auth/portal-access", () => ({ getPortalAccessContext: async () => state.portal }));
// The fake db models no service-workspace tables; these viewers are not service staff.
vi.mock("@/lib/service/service-mode.server", () => ({
  loadServiceStaffScope: async () => null,
  loadServiceStaffScopeOrThrow: async () => null,
}));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async () => state.admin }));
vi.mock("@/lib/planned-schedule-persistence.server", () => ({
  replaceManagerPlannedScheduleSlice: vi.fn(async () => ({ available: true, ok: true, idempotent: false })),
}));
vi.mock("@/lib/google-calendar/sync.server", () => ({ syncManagerAvailabilityToGoogleCalendar: vi.fn() }));
vi.mock("@/lib/tour-events.server", () => ({ emitAvailabilityChangedEvent: vi.fn() }));
vi.mock("@/lib/property-owner.server", () => ({ resolvePropertyOwnerUserId: vi.fn(async () => null) }));
vi.mock("@/lib/auth/co-manager-module-scope", () => ({
  linkedOwnerScopeForModule: async () => ({ propertyIds: [] }),
}));
// The one thing under test: whether the route now CONSULTS this, not whether
// it resolves correctly (that is `co-manager-workspace-scope-leak.test.ts`'s job).
vi.mock("@/lib/workspaces/scope.server", () => ({
  activeWorkspacePropertyScope: vi.fn(async () => {
    if (state.scopeUnavailable) {
      const { WorkspaceScopeUnavailableError } = await import("@/lib/workspaces/scope-unavailable");
      throw new WorkspaceScopeUnavailableError();
    }
    return state.workspaceScope;
  }),
}));

type Query = Record<string, unknown> & PromiseLike<{ data: Row[]; error: null }>;

function query(table: string): Query {
  const filters: Record<string, unknown> = {};
  let deleting = false;
  const chain: Record<string, unknown> = {};
  const rowsFor = (): Row[] => {
    if (table !== "portal_schedule_records") return [];
    const id = typeof filters.id === "string" ? filters.id : null;
    const ids = Array.isArray(filters["in:id"]) ? (filters["in:id"] as unknown[]) : null;
    const propertyIds = Array.isArray(filters["in:property_id"]) ? (filters["in:property_id"] as unknown[]) : null;
    const source = id
      ? state.scheduleRows.filter((row) => row.id === id)
      : ids
        ? state.scheduleRows.filter((row) => ids.includes(row.id))
        : propertyIds
          ? state.scheduleRows.filter((row) => propertyIds.includes(row.property_id))
          : state.scheduleRows;
    const excluded = Array.isArray(filters.neq) ? filters.neq : [];
    const ordinary = excluded.length > 0 ? source.filter((row) => !excluded.includes(row.id)) : source;
    if (filters.scope === true && !state.admin) {
      const viewer = (state.portal.user as { id: string }).id;
      const scoped = ordinary.filter((row) => {
        if (row.id === "axis_admin_planned_events_v1" || row.id === "axis_admin_partner_inquiries_v1") return true;
        return row.manager_user_id === viewer;
      });
      return typeof filters.limit === "number" ? scoped.slice(0, filters.limit) : scoped;
    }
    return typeof filters.limit === "number" ? ordinary.slice(0, filters.limit) : ordinary;
  };
  const result = async () => {
    const rows = rowsFor();
    if (deleting && table === "portal_schedule_records") {
      const ids = new Set(rows.map((row) => String(row.id)));
      state.scheduleRows = state.scheduleRows.filter((row) => !ids.has(String(row.id)));
      return { data: rows.map((row) => ({ id: row.id })), error: null };
    }
    return { data: rows, error: null };
  };
  Object.assign(chain, {
    select: () => chain,
    order: () => chain,
    limit: (value: number) => {
      filters.limit = value;
      return chain;
    },
    eq: (column: string, value: unknown) => {
      filters[column] = value;
      return chain;
    },
    in: (column: string, values: unknown[]) => {
      filters[`in:${column}`] = values;
      return chain;
    },
    neq: (_column: string, value: unknown) => {
      const excluded = Array.isArray(filters.neq) ? filters.neq : [];
      filters.neq = [...excluded, value];
      return chain;
    },
    or: () => {
      filters.scope = true;
      return chain;
    },
    delete: () => {
      deleting = true;
      return chain;
    },
    upsert: async (row: Row) => {
      const idx = state.scheduleRows.findIndex((r) => r.id === row.id);
      if (idx >= 0) state.scheduleRows[idx] = { ...state.scheduleRows[idx], ...row };
      else state.scheduleRows.push({ ...row });
      return { error: null };
    },
    maybeSingle: async () => ({ data: rowsFor()[0] ?? null, error: null }),
    then: (resolve: (value: { data: Row[]; error: null }) => unknown, reject?: (reason: unknown) => unknown) =>
      result().then(resolve, reject),
  });
  return chain as Query;
}

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({ from: (table: string) => query(table) }),
}));

function portal(id: string, roles: string[] = ["manager"]) {
  state.admin = roles.includes("admin");
  state.portal = {
    user: { id, email: `${id}@example.test` },
    roles,
    effectiveRole: roles.length === 1 ? roles[0] : null,
    profile: { email: `${id}@example.test`, role: roles[0] },
  };
}

function post(body: Record<string, unknown>) {
  return new Request("http://localhost/api/portal-schedule-records", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const event = (id: string, propertyId: string | null, managerUserId = "owner-a") => ({
  id,
  manager_user_id: managerUserId,
  property_id: propertyId,
  record_type: "event",
  row_data: { id, propertyId },
  updated_at: "2026-01-01T00:00:00.000Z",
});

beforeEach(() => {
  vi.clearAllMocks();
  portal("owner-a");
  state.scheduleRows = [];
  state.workspaceScope = null;
  state.scopeUnavailable = false;
});

describe("GET /api/portal-schedule-records — narrows to the active workspace", () => {
  it("shows only house-a rows while workspace A (house-a) is active", async () => {
    state.scheduleRows = [event("ev-a", "house-a"), event("ev-b", "house-b")];
    state.workspaceScope = ["house-a"];
    const { GET } = await import("@/app/api/portal-schedule-records/route");
    const res = await GET();
    const body = (await res.json()) as { rows: { id: string }[] };
    expect(body.rows.map((r) => r.id)).toEqual(["ev-a"]);
  });

  it("returns nothing for a workspace holding zero houses", async () => {
    state.scheduleRows = [event("ev-a", "house-a"), event("ev-b", "house-b")];
    state.workspaceScope = [];
    const { GET } = await import("@/app/api/portal-schedule-records/route");
    const res = await GET();
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toEqual([]);
  });

  it("is unaffected for a single-workspace manager (scope null)", async () => {
    state.scheduleRows = [event("ev-a", "house-a"), event("ev-b", "house-b")];
    state.workspaceScope = null;
    const { GET } = await import("@/app/api/portal-schedule-records/route");
    const res = await GET();
    const body = (await res.json()) as { rows: { id: string }[] };
    expect(body.rows.map((r) => r.id).sort()).toEqual(["ev-a", "ev-b"]);
  });

  it("switching workspaces shows the other workspace's rows instead", async () => {
    state.scheduleRows = [event("ev-a", "house-a"), event("ev-b", "house-b")];
    const { GET } = await import("@/app/api/portal-schedule-records/route");
    state.workspaceScope = ["house-b"];
    const res = await GET();
    const body = (await res.json()) as { rows: { id: string }[] };
    expect(body.rows.map((r) => r.id)).toEqual(["ev-b"]);
  });

  it("leaves an account-level row (no property_id) visible regardless of workspace", async () => {
    state.scheduleRows = [event("ev-a", "house-a"), { ...event("cache-row", null), record_type: "manager_availability" }];
    state.workspaceScope = ["house-b"];
    const { GET } = await import("@/app/api/portal-schedule-records/route");
    const res = await GET();
    const body = (await res.json()) as { rows: { id: string }[] };
    expect(body.rows.map((r) => r.id)).toEqual(["cache-row"]);
  });
});

// Issue #103: the shared inquiry / planned-events singletons hold EVERY workspace's items in one row, whose
// `property_id` column is just the house of whoever wrote last. Keeping or dropping the whole row by that column hid
// one workspace's requests (and, for a staff viewer, leaked another's). They are narrowed item by item instead.
describe("GET /api/portal-schedule-records — shared singletons narrow by item, not by their last-writer column", () => {
  const singleton = (id: string, columnHouse: string | null, items: Record<string, unknown>[]) => ({
    id,
    manager_user_id: null,
    property_id: columnHouse,
    record_type: id,
    row_data: { id, recordType: id, managerUserId: null, propertyId: null, payload: items },
    updated_at: "2026-01-01T00:00:00.000Z",
  });
  const inquiry = (id: string, propertyId: string) => ({ id, propertyId, status: "pending", managerUserId: "owner-a" });
  const itemIds = async (): Promise<string[]> => {
    const { GET } = await import("@/app/api/portal-schedule-records/route");
    const res = await GET();
    const body = (await res.json()) as { rows: { id: string; payload?: { id: string }[] }[] };
    return body.rows.filter((r) => r.id === "axis_admin_partner_inquiries_v1").flatMap((r) => (r.payload ?? []).map((i) => i.id));
  };

  it("with B active and the singleton stamped to a B house, shows none of A's requests", async () => {
    state.scheduleRows = [
      singleton("axis_admin_partner_inquiries_v1", "house-b1", [inquiry("req-a1", "house-a1"), inquiry("req-a2", "house-a2")]),
    ];
    state.workspaceScope = ["house-b1", "house-b2"];
    expect(await itemIds()).toEqual([]);
  });

  it("with A active and the singleton stamped to a B house, still shows all of A's requests", async () => {
    state.scheduleRows = [
      singleton("axis_admin_partner_inquiries_v1", "house-b1", [inquiry("req-a1", "house-a1"), inquiry("req-a2", "house-a2"), inquiry("req-b1", "house-b1")]),
    ];
    state.workspaceScope = ["house-a1", "house-a2"];
    expect((await itemIds()).sort()).toEqual(["req-a1", "req-a2"]);
  });

  it("shows B's own request under B even though the column names an A house", async () => {
    state.scheduleRows = [
      singleton("axis_admin_partner_inquiries_v1", "house-a1", [inquiry("req-a1", "house-a1"), inquiry("req-b1", "house-b1")]),
    ];
    state.workspaceScope = ["house-b1"];
    expect(await itemIds()).toEqual(["req-b1"]);
  });

  // The planned-events save (`replace_manager_planned_schedule_slice`) compares the caller's WHOLE stored slice,
  // every house and workspace, against what the browser observed — so the viewer's own items are never narrowed.
  it("keeps the viewer's own planned events in every workspace so the whole-slice save still matches", async () => {
    state.scheduleRows = [
      singleton("axis_admin_planned_events_v1", "house-b1", [
        { id: "pl-a", propertyId: "house-a1", managerUserId: "owner-a" },
        { id: "pl-b", propertyId: "house-b1", managerUserId: "owner-a" },
      ]),
    ];
    const { GET } = await import("@/app/api/portal-schedule-records/route");
    for (const scope of [["house-b1"], ["house-a1"]]) {
      state.workspaceScope = scope;
      const body = (await (await GET()).json()) as { rows: { id: string; payload?: { id: string }[] }[] };
      const planned = body.rows.find((r) => r.id === "axis_admin_planned_events_v1");
      expect((planned?.payload ?? []).map((i) => i.id).sort(), scope.join()).toEqual(["pl-a", "pl-b"]);
    }
  });

  it("reads the active workspace once per GET", async () => {
    state.scheduleRows = [event("ev-a", "house-a")];
    state.workspaceScope = ["house-a"];
    const { activeWorkspacePropertyScope } = await import("@/lib/workspaces/scope.server");
    const { GET } = await import("@/app/api/portal-schedule-records/route");
    await GET();
    expect(vi.mocked(activeWorkspacePropertyScope)).toHaveBeenCalledTimes(1);
  });

  it("answers 503 (never an unfiltered 200) when the workspace cannot be resolved", async () => {
    state.scheduleRows = [event("ev-a", "house-a"), event("ev-b", "house-b")];
    state.scopeUnavailable = true;
    const { GET } = await import("@/app/api/portal-schedule-records/route");
    const res = await GET();
    expect(res.status).not.toBe(200);
  });
});

// The Google sync owns the `axis_gcal_…` rows: a tour's calendar holder, the availability / vendor push state, a
// pending event. The holder row decides whose Google connection a tour's event (with the prospect's name, email and
// phone in its description) is written to and later deleted from, so a body may never name one — whatever record type
// it claims. The oracle is `tourCalendarOwnerRecordId`'s own id shape.
describe("POST /api/portal-schedule-records — server-owned ids are not writable by a client", () => {
  it("refuses a planted tour calendar-owner row and stores nothing", async () => {
    const { POST } = await import("@/app/api/portal-schedule-records/route");
    const res = await POST(
      post({
        row: {
          id: tourCalendarOwnerRecordId("planned-1"),
          recordType: "event",
          plannedEventId: "planned-1",
          connectionOwnerUserId: "victim-manager",
        },
      }),
    );
    expect(res.status).toBe(403);
    expect(state.scheduleRows).toEqual([]);
  });

  it("refuses the other server-owned schedule ids too", async () => {
    const { POST } = await import("@/app/api/portal-schedule-records/route");
    for (const id of ["axis_gcal_avail_push_rec-1", "axis_gcal_pending_owner-a_evt-1", "axis_gcal_vendor_avail_push_v1"]) {
      const res = await POST(post({ row: { id, recordType: "event" } }));
      expect(res.status, id).toBe(403);
    }
    expect(state.scheduleRows).toEqual([]);
  });

  it("refuses an overwrite of the caller's own existing calendar-owner row and leaves it as the sync wrote it", async () => {
    const stored = {
      id: tourCalendarOwnerRecordId("planned-1"),
      manager_user_id: "owner-a",
      property_id: null,
      record_type: "google_tour_calendar_owner",
      row_data: { recordType: "google_tour_calendar_owner", plannedEventId: "planned-1", connectionOwnerUserId: "owner-a" },
    };
    state.scheduleRows = [stored];
    const { POST } = await import("@/app/api/portal-schedule-records/route");
    const res = await POST(
      post({
        row: {
          id: stored.id,
          recordType: "google_tour_calendar_owner",
          plannedEventId: "planned-1",
          connectionOwnerUserId: "victim-manager",
        },
      }),
    );
    expect(res.status).toBe(403);
    expect(state.scheduleRows).toEqual([stored]);
  });

  it("leaves an ordinary calendar event writable", async () => {
    const { POST } = await import("@/app/api/portal-schedule-records/route");
    const res = await POST(post({ row: { id: "ev-ok", propertyId: "house-a", recordType: "event" } }));
    expect(res.status).toBe(200);
    expect(state.scheduleRows.map((r) => r.id)).toEqual(["ev-ok"]);
  });
});

describe("POST /api/portal-schedule-records — a create/update must land in the active workspace", () => {
  it("refuses an upsert naming a house outside the active workspace", async () => {
    state.workspaceScope = ["house-a"];
    const { POST } = await import("@/app/api/portal-schedule-records/route");
    const res = await POST(post({ row: { id: "new-1", propertyId: "house-b", recordType: "event" } }));
    expect(res.status).toBe(403);
    expect(state.scheduleRows).toEqual([]);
  });

  it("allows an upsert naming a house inside the active workspace", async () => {
    state.workspaceScope = ["house-a"];
    const { POST } = await import("@/app/api/portal-schedule-records/route");
    const res = await POST(post({ row: { id: "new-2", propertyId: "house-a", recordType: "event" } }));
    expect(res.status).toBe(200);
    expect(state.scheduleRows.map((r) => r.id)).toEqual(["new-2"]);
  });

  it("refuses to delete a row whose house is outside the active workspace", async () => {
    state.scheduleRows = [event("ev-b", "house-b")];
    state.workspaceScope = ["house-a"];
    const { POST } = await import("@/app/api/portal-schedule-records/route");
    const res = await POST(post({ action: "delete", id: "ev-b" }));
    expect(res.status).toBe(404);
    expect(state.scheduleRows).toHaveLength(1);
  });

  it("is unaffected for a single-workspace manager (scope null)", async () => {
    state.workspaceScope = null;
    const { POST } = await import("@/app/api/portal-schedule-records/route");
    const res = await POST(post({ row: { id: "new-3", propertyId: "house-anything", recordType: "event" } }));
    expect(res.status).toBe(200);
  });
});
