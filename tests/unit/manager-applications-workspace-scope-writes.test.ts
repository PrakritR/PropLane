/**
 * Route-level regression: `POST /api/manager-applications` as a manager with
 * MULTIPLE workspaces, for every write verb the route serves.
 *
 * A create must land in the active workspace, and an update or delete must
 * refuse a row outside it (the same rule the shared workspace-scoping work
 * applies everywhere): `resolveApplicationWriteOwner` gates both the
 * single-row `upsert` and the manager panel's `replace` batch (same
 * function, one choke point); `assertCanDeleteApplicationRecords` gates
 * `action: "delete"`. `null` (no workspaces / load failure) never narrows.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { CoManagerPermissionLevel } from "@/lib/co-manager-permissions";

type StoredRecord = {
  id: string;
  row_data: DemoApplicantRow;
  manager_user_id: string | null;
  resident_email: string | null;
  property_id: string | null;
  assigned_property_id: string | null;
};

const getUser = vi.fn();
let PROFILE: { role: string; email: string } | null;
let PROPERTIES: { id: string; manager_user_id: string }[];
let APP_ROWS: StoredRecord[];
let DELETED_IDS: string[];
let UPSERTS: { id: string; manager_user_id: string | null; row_data: DemoApplicantRow }[];
let ACTIVE_WORKSPACE_SCOPE: string[] | null;
// userId -> propertyId -> levels the co-manager link grants (unused directly here, kept for parity with the shared mock shape)
let CO_MANAGER_GRANTS: Record<string, Record<string, CoManagerPermissionLevel[]>>;

vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: vi.fn(async () => false) }));
vi.mock("@/lib/auth/co-manager-module-scope", () => ({
  linkedPropertyIdsForModule: vi.fn(async () => new Set<string>()),
  linkedOwnerForProperty: vi.fn(async () => null),
}));
vi.mock("@/lib/auth/manager-lease-scope", () => ({
  managerHasCoManagerPermissionForProperty: vi.fn(
    async (_db: unknown, userId: string, propertyId: string, _module: string, level: CoManagerPermissionLevel = "read") =>
      (CO_MANAGER_GRANTS[userId]?.[propertyId] ?? []).includes(level),
  ),
}));
vi.mock("@/lib/auth/provision-approved-resident", () => ({
  provisionApprovedResidentAccount: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/screening/order-screening", () => ({ tryAutoOrderScreening: vi.fn() }));
vi.mock("@/lib/workspaces/scope.server", () => ({
  activeWorkspacePropertyScope: vi.fn(async () => ACTIVE_WORKSPACE_SCOPE),
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => makeDb() }));

/** Chainable Supabase stub covering exactly the tables/filters this route touches for upsert + delete. */
function makeDb() {
  return {
    storage: { from: () => ({ list: async () => ({ data: [], error: null }), remove: async () => ({ error: null }) }) },
    from(table: string) {
      const state: {
        ids: string[] | null;
        eqCol: string | null;
        eqVal: string | null;
        selectCols: string | null;
      } = { ids: null, eqCol: null, eqVal: null, selectCols: null };
      const rowsFor = (): unknown[] => {
        if (table === "manager_property_records") {
          if (state.eqCol === "manager_user_id") return PROPERTIES.filter((p) => p.manager_user_id === state.eqVal);
          return PROPERTIES;
        }
        if (table === "manager_application_records") {
          let rows = APP_ROWS;
          if (state.ids) rows = rows.filter((r) => state.ids?.includes(r.id));
          return rows;
        }
        return [];
      };
      const builder: Record<string, unknown> = {
        select: (cols?: string) => {
          state.selectCols = cols ?? null;
          return builder;
        },
        upsert(values: { id: string; manager_user_id: string | null; row_data: DemoApplicantRow }) {
          if (table === "manager_application_records") {
            UPSERTS.push(values);
            const idx = APP_ROWS.findIndex((r) => r.id === values.id);
            const next: StoredRecord = {
              id: values.id,
              row_data: values.row_data,
              manager_user_id: values.manager_user_id,
              resident_email: values.row_data.email ?? null,
              property_id: (values as unknown as { property_id?: string | null }).property_id ?? null,
              assigned_property_id: (values as unknown as { assigned_property_id?: string | null }).assigned_property_id ?? null,
            };
            if (idx >= 0) APP_ROWS[idx] = next;
            else APP_ROWS.push(next);
          }
          return Promise.resolve({ error: null });
        },
        eq(column: string, value: string) {
          state.eqCol = column;
          state.eqVal = value;
          return builder;
        },
        in(column: string, values: string[]) {
          if (column === "id") state.ids = values;
          return builder;
        },
        is: () => builder,
        // The resident quota on create/approve excludes the row being written.
        neq: () => builder,
        ilike: () => builder,
        or: () => builder,
        delete() {
          const applyDelete = (values: string[]) => {
            if (table === "manager_application_records") {
              DELETED_IDS.push(...values);
              APP_ROWS = APP_ROWS.filter((r) => !values.includes(r.id));
            }
            return Promise.resolve({ error: null });
          };
          return {
            in: (_column: string, values: string[]) => applyDelete(values),
            eq: (_column: string, value: string) => applyDelete([value]),
            filter: () => Promise.resolve({ error: null }),
          };
        },
        order: () => builder,
        limit: () => builder,
        maybeSingle() {
          if (table === "profiles") return Promise.resolve({ data: PROFILE, error: null });
          if (table === "manager_property_records") {
            // The (unrelated) test-workspace gate's own read, keyed on this select.
            if (state.selectCols === "test_workspace_id") return Promise.resolve({ data: null, error: null });
            return Promise.resolve({ data: null, error: null });
          }
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

async function upsert(row: DemoApplicantRow) {
  const { POST } = await import("@/app/api/manager-applications/route");
  const res = await POST(
    new Request("http://localhost/api/manager-applications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "upsert", row }),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function deleteApplication(id: string) {
  const { POST } = await import("@/app/api/manager-applications/route");
  const res = await POST(
    new Request("http://localhost/api/manager-applications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", id }),
    }),
  );
  return { status: res.status, body: (await res.json()) as { ok?: boolean; deleted?: number; error?: string } };
}

const MANAGER = "mgr-workspace-writer";
const MANAGER_EMAIL = "writer@test.proplane.local";
const HOUSE_A = "house-a-active-workspace";
const HOUSE_B = "house-b-other-workspace";

function existingRow(id: string, propertyId: string): StoredRecord {
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
    resident_email: `${id.toLowerCase()}@example.com`,
    property_id: propertyId,
    assigned_property_id: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  PROFILE = { role: "manager", email: MANAGER_EMAIL };
  getUser.mockResolvedValue({
    data: { user: { id: MANAGER, email: MANAGER_EMAIL, user_metadata: {} } },
    error: null,
  });
  PROPERTIES = [
    { id: HOUSE_A, manager_user_id: MANAGER },
    { id: HOUSE_B, manager_user_id: MANAGER },
  ];
  APP_ROWS = [];
  DELETED_IDS = [];
  UPSERTS = [];
  CO_MANAGER_GRANTS = {};
  ACTIVE_WORKSPACE_SCOPE = null;
});

describe("POST /api/manager-applications — active-workspace write gating", () => {
  it("refuses an UPDATE to the manager's own row when its house is outside the active workspace", async () => {
    ACTIVE_WORKSPACE_SCOPE = [HOUSE_A];
    APP_ROWS = [existingRow("PROPLANE-EDIT-B", HOUSE_B)];

    const { status } = await upsert({ ...APP_ROWS[0]!.row_data, detail: "edited" });

    expect(status).toBe(403);
    expect(UPSERTS).toHaveLength(0);
  });

  it("allows an UPDATE to the manager's own row when its house IS in the active workspace", async () => {
    ACTIVE_WORKSPACE_SCOPE = [HOUSE_A];
    APP_ROWS = [existingRow("PROPLANE-EDIT-A", HOUSE_A)];

    const { status } = await upsert({ ...APP_ROWS[0]!.row_data, detail: "edited" });

    expect(status).toBe(200);
    expect(UPSERTS).toHaveLength(1);
  });

  it("refuses a CREATE (a new manually-added applicant) on a house outside the active workspace", async () => {
    ACTIVE_WORKSPACE_SCOPE = [HOUSE_A];
    const newRow: DemoApplicantRow = {
      id: "PROPLANE-NEW-B",
      name: "New Applicant",
      email: "new-applicant@example.com",
      property: HOUSE_B,
      propertyId: HOUSE_B,
      stage: "Submitted",
      bucket: "pending",
      detail: "",
      manuallyAdded: true,
    } as DemoApplicantRow;

    const { status } = await upsert(newRow);

    expect(status).toBe(403);
    expect(UPSERTS).toHaveLength(0);
  });

  it("allows a CREATE on a house inside the active workspace (no regression)", async () => {
    ACTIVE_WORKSPACE_SCOPE = [HOUSE_A];
    const newRow: DemoApplicantRow = {
      id: "PROPLANE-NEW-A",
      name: "New Applicant",
      email: "new-applicant-a@example.com",
      property: HOUSE_A,
      propertyId: HOUSE_A,
      stage: "Submitted",
      bucket: "pending",
      detail: "",
      manuallyAdded: true,
    } as DemoApplicantRow;

    const { status } = await upsert(newRow);

    expect(status).toBe(200);
    expect(UPSERTS).toHaveLength(1);
  });

  it("a manager with no workspaces (null scope) is unaffected — an update off-list still succeeds", async () => {
    ACTIVE_WORKSPACE_SCOPE = null;
    APP_ROWS = [existingRow("PROPLANE-EDIT-NULL", HOUSE_B)];

    const { status } = await upsert({ ...APP_ROWS[0]!.row_data, detail: "edited" });

    expect(status).toBe(200);
    expect(UPSERTS).toHaveLength(1);
  });

  it("refuses a DELETE of a row outside the active workspace", async () => {
    ACTIVE_WORKSPACE_SCOPE = [HOUSE_A];
    APP_ROWS = [existingRow("PROPLANE-DEL-B", HOUSE_B)];

    const { status, body } = await deleteApplication("PROPLANE-DEL-B");

    expect(status).toBe(403);
    expect(body.error).toMatch(/active workspace/i);
    expect(DELETED_IDS).toHaveLength(0);
  });

  it("allows a DELETE of a row inside the active workspace (no regression)", async () => {
    ACTIVE_WORKSPACE_SCOPE = [HOUSE_A];
    APP_ROWS = [existingRow("PROPLANE-DEL-A", HOUSE_A)];

    const { status, body } = await deleteApplication("PROPLANE-DEL-A");

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(DELETED_IDS).toContain("PROPLANE-DEL-A");
  });
});
