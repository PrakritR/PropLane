/**
 * Route-level regression: `GET /api/manager-applications` as a manager with
 * MULTIPLE workspaces.
 *
 * `fetchApplicationsForManagerUser` is the ONE query behind three tabs —
 * Applications, Residents (`pro-residents.tsx` fetches this same route), and
 * the "approved" bucket of Leases — so proving it here covers all three.
 * Before this change it queried by `manager_user_id` / co-manager-linked
 * `property_id` alone, so a manager's rows merged across every workspace they
 * own. This proves the active-workspace predicate now narrows every list, on
 * the server, using the three rules every workspace-scoped surface shares:
 * `null` (no workspaces / load failure) never narrows; a resolved array
 * restricts to those houses; an empty array (the workspace holds none) yields
 * no property-scoped rows.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";

type StoredRecord = {
  id: string;
  row_data: DemoApplicantRow;
  manager_user_id: string | null;
  property_id: string | null;
  assigned_property_id: string | null;
  updated_at: string;
};

const getUser = vi.fn();
let PROFILE: { role: string; email: string } | null;
let PROPERTIES: { id: string; manager_user_id: string }[];
let APP_ROWS: StoredRecord[];
/** `null` = not narrowing (matches `activeWorkspacePropertyScope`'s own contract). */
let ACTIVE_WORKSPACE_SCOPE: string[] | null;

vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: vi.fn(async () => false) }));
vi.mock("@/lib/auth/co-manager-module-scope", () => ({
  linkedPropertyIdsForModule: vi.fn(async () => new Set<string>()),
}));
vi.mock("@/lib/auth/provision-approved-resident", () => ({
  provisionApprovedResidentAccount: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/workspaces/scope.server", () => ({
  activeWorkspacePropertyScope: vi.fn(async () => ACTIVE_WORKSPACE_SCOPE),
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => makeDb() }));

/** Minimal chainable Supabase stub covering exactly the tables/filters this route touches. */
function makeDb() {
  return {
    from(table: string) {
      const filters: { eqCol: string | null; eqVal: string | null; inCol: string | null; inVals: string[] | null } = {
        eqCol: null,
        eqVal: null,
        inCol: null,
        inVals: null,
      };
      const rowsFor = (): unknown[] => {
        if (table === "manager_property_records") {
          if (filters.eqCol === "manager_user_id") return PROPERTIES.filter((p) => p.manager_user_id === filters.eqVal);
          return PROPERTIES;
        }
        if (table === "manager_application_records") {
          let rows = APP_ROWS;
          if (filters.eqCol === "manager_user_id") rows = rows.filter((r) => r.manager_user_id === filters.eqVal);
          if (filters.inCol) rows = rows.filter((r) => filters.inVals?.includes(String((r as StoredRecord)[filters.inCol as keyof StoredRecord] ?? "")));
          return rows;
        }
        return [];
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq(column: string, value: string) {
          filters.eqCol = column;
          filters.eqVal = value;
          return builder;
        },
        in(column: string, values: string[]) {
          filters.inCol = column;
          filters.inVals = values;
          return builder;
        },
        is: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle() {
          if (table === "profiles") return Promise.resolve({ data: PROFILE, error: null });
          return Promise.resolve({ data: null, error: null });
        },
        then(resolve: (v: { data: unknown; error: unknown }) => unknown) {
          return Promise.resolve({ data: rowsFor(), error: null }).then(resolve);
        },
      };
      return builder;
    },
  };
}

async function getApplications() {
  const { GET } = await import("@/app/api/manager-applications/route");
  const res = await GET(new Request("https://example.test/api/manager-applications"));
  return { status: res.status, body: (await res.json()) as { rows?: DemoApplicantRow[]; error?: string } };
}

const MANAGER = "mgr-multi-workspace";
const HOUSE_A = "house-a-in-workspace-a";
const HOUSE_B = "house-b-in-workspace-b";

function appRow(id: string, propertyId: string, over: Partial<StoredRecord> = {}): StoredRecord {
  return {
    id,
    row_data: {
      id,
      name: id,
      email: `${id.toLowerCase()}@example.com`,
      property: propertyId,
      propertyId,
      stage: "Submitted",
      bucket: "pending",
      detail: "",
      managerUserId: MANAGER,
    } as DemoApplicantRow,
    manager_user_id: MANAGER,
    property_id: propertyId,
    assigned_property_id: null,
    updated_at: "2026-07-01T00:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  PROFILE = { role: "manager", email: "owner@test.proplane.local" };
  getUser.mockResolvedValue({
    data: { user: { id: MANAGER, email: "owner@test.proplane.local", user_metadata: {} } },
    error: null,
  });
  PROPERTIES = [
    { id: HOUSE_A, manager_user_id: MANAGER },
    { id: HOUSE_B, manager_user_id: MANAGER },
  ];
  APP_ROWS = [appRow("PROPLANE-HOUSEA1", HOUSE_A), appRow("PROPLANE-HOUSEB1", HOUSE_B)];
  ACTIVE_WORKSPACE_SCOPE = null;
});

describe("GET /api/manager-applications — active-workspace narrowing", () => {
  it("shows only workspace A's rows while workspace A is active", async () => {
    ACTIVE_WORKSPACE_SCOPE = [HOUSE_A];

    const { status, body } = await getApplications();

    expect(status).toBe(200);
    expect(body.rows?.map((r) => r.id)).toEqual(["PROPLANE-HOUSEA1"]);
  });

  it("switching the active workspace to B shows only B's rows", async () => {
    ACTIVE_WORKSPACE_SCOPE = [HOUSE_B];

    const { status, body } = await getApplications();

    expect(status).toBe(200);
    expect(body.rows?.map((r) => r.id)).toEqual(["PROPLANE-HOUSEB1"]);
  });

  it("an empty workspace (holds no houses) yields no rows, even though the manager owns houses elsewhere", async () => {
    ACTIVE_WORKSPACE_SCOPE = [];

    const { status, body } = await getApplications();

    expect(status).toBe(200);
    expect(body.rows).toHaveLength(0);
  });

  it("a manager with no workspaces (null scope) is unaffected — sees every owned row, exactly as before", async () => {
    ACTIVE_WORKSPACE_SCOPE = null;

    const { status, body } = await getApplications();

    expect(status).toBe(200);
    expect(body.rows?.map((r) => r.id).sort()).toEqual(["PROPLANE-HOUSEA1", "PROPLANE-HOUSEB1"]);
  });

  it("narrows a group application per member's OWN house, without blocking the group or dropping a member whose house the workspace holds", async () => {
    // Same shared Group ID (AXISGRP-…), one member per house — real "spans
    // houses" households exist (docs/agents/group-applications.md). Group A1
    // is entirely inside workspace A; group A1's second member sits on
    // HOUSE_B and must vanish from workspace A on their own account (their
    // house genuinely is not in it) — never because the group mechanism
    // blocked or bundled them.
    APP_ROWS = [
      appRow("PROPLANE-GROUP-A1", HOUSE_A, {
        row_data: {
          id: "PROPLANE-GROUP-A1",
          name: "Group Member A",
          email: "member-a@example.com",
          property: HOUSE_A,
          propertyId: HOUSE_A,
          stage: "Submitted",
          bucket: "pending",
          detail: "",
          managerUserId: MANAGER,
          application: { groupId: "AXISGRP-SAMEHOUSEHOLD" } as unknown as DemoApplicantRow["application"],
        } as DemoApplicantRow,
      }),
      appRow("PROPLANE-GROUP-A2", HOUSE_A, {
        row_data: {
          id: "PROPLANE-GROUP-A2",
          name: "Group Member A2",
          email: "member-a2@example.com",
          property: HOUSE_A,
          propertyId: HOUSE_A,
          stage: "Submitted",
          bucket: "pending",
          detail: "",
          managerUserId: MANAGER,
          application: { groupId: "AXISGRP-SAMEHOUSEHOLD" } as unknown as DemoApplicantRow["application"],
        } as DemoApplicantRow,
      }),
      appRow("PROPLANE-GROUP-B1", HOUSE_B, {
        row_data: {
          id: "PROPLANE-GROUP-B1",
          name: "Group Member On Other House",
          email: "member-b@example.com",
          property: HOUSE_B,
          propertyId: HOUSE_B,
          stage: "Submitted",
          bucket: "pending",
          detail: "",
          managerUserId: MANAGER,
          application: { groupId: "AXISGRP-SAMEHOUSEHOLD" } as unknown as DemoApplicantRow["application"],
        } as DemoApplicantRow,
      }),
    ];
    ACTIVE_WORKSPACE_SCOPE = [HOUSE_A];

    const { status, body } = await getApplications();

    expect(status).toBe(200);
    // Both HOUSE_A members of the group show — the group never blocks or
    // hides a member whose own house the active workspace genuinely holds.
    expect(body.rows?.map((r) => r.id).sort()).toEqual(["PROPLANE-GROUP-A1", "PROPLANE-GROUP-A2"]);
  });
});
