import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tours / bookings / calendar (`portal_schedule_records`, one table backing
 * several record kinds) never applied the active-workspace predicate: a
 * manager with two workspaces read and wrote rows across both from one
 * portal session. `activeWorkspacePropertyScope` is mocked directly here
 * (its own correctness is covered by `co-manager-workspace-scope-leak.test.ts`)
 * so these tests isolate exactly the new call sites in the route itself.
 */

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
}));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: (task: () => unknown) => void task() };
});
vi.mock("@/lib/auth/portal-access", () => ({ getPortalAccessContext: async () => state.portal }));
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
  activeWorkspacePropertyScope: vi.fn(async () => state.workspaceScope),
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
