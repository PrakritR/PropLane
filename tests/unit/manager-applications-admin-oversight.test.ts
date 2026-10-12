/**
 * `GET /api/manager-applications` is the manager portal's applications / residents read. A platform
 * admin using their own manager portal used to get EVERY owner's rows (an unscoped admin branch),
 * which put another owner's residents in their Communication. The all-owners read now needs an
 * explicit `?oversight=admin` AND the server-confirmed admin role.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Stored = {
  id: string;
  row_data: Record<string, unknown>;
  manager_user_id: string | null;
  property_id: string | null;
  assigned_property_id: string | null;
  updated_at: string;
};

const getUser = vi.fn();
let APP_ROWS: Stored[];
let VIEWER_IS_ADMIN = true;
const ADMIN = "mgr-admin";
const AMBIKA = "mgr-ambika";
const ADMIN_HOUSE = "house-admin";
const SEATTLE_HOUSE = "house-seattle";
const PROPS = [
  { id: ADMIN_HOUSE, manager_user_id: ADMIN },
  { id: SEATTLE_HOUSE, manager_user_id: AMBIKA },
];

vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: vi.fn(async () => VIEWER_IS_ADMIN) }));
vi.mock("@/lib/auth/co-manager-module-scope", () => ({ linkedPropertyIdsForModule: vi.fn(async () => new Set<string>()) }));
vi.mock("@/lib/auth/provision-approved-resident", () => ({ provisionApprovedResidentAccount: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/workspaces/scope.server", () => ({ activeWorkspacePropertyScope: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser } }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => makeDb() }));

function makeDb() {
  return {
    from(table: string) {
      const f: { eqCol: string | null; eqVal: string | null; inCol: string | null; inVals: string[] | null } = { eqCol: null, eqVal: null, inCol: null, inVals: null };
      const rowsFor = (): unknown[] => {
        if (table === "manager_property_records") {
          return f.eqCol === "manager_user_id" ? PROPS.filter((p) => p.manager_user_id === f.eqVal) : PROPS;
        }
        if (table === "account_link_invites") return [];
        if (table === "manager_application_records") {
          let rows = APP_ROWS;
          if (f.eqCol === "manager_user_id") rows = rows.filter((r) => r.manager_user_id === f.eqVal);
          if (f.inCol) rows = rows.filter((r) => f.inVals?.includes(String(r[f.inCol as keyof Stored] ?? "")));
          return rows;
        }
        return [];
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq(column: string, value: string) {
          f.eqCol = column;
          f.eqVal = value;
          return builder;
        },
        in(column: string, values: string[]) {
          f.inCol = column;
          f.inVals = values;
          return builder;
        },
        is: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: () => Promise.resolve({ data: table === "profiles" ? { role: "manager", email: "viewer@test.local" } : null, error: null }),
        then(resolve: (v: { data: unknown; error: unknown }) => unknown) {
          return Promise.resolve({ data: rowsFor(), error: null }).then(resolve);
        },
      };
      return builder;
    },
  };
}

function resident(id: string, owner: string, house: string): Stored {
  return {
    id,
    row_data: { id, name: id, email: `${id.toLowerCase()}@example.com`, bucket: "approved", stage: "Active", detail: "", managerUserId: owner, propertyId: house },
    manager_user_id: owner,
    property_id: house,
    assigned_property_id: house,
    updated_at: "2026-07-01T00:00:00.000Z",
  };
}

async function ids(query = "") {
  const { GET } = await import("@/app/api/manager-applications/route");
  const res = await GET(new Request(`https://example.test/api/manager-applications${query}`));
  expect(res.status).toBe(200);
  return ((await res.json()) as { rows: { id: string }[] }).rows.map((r) => r.id).sort();
}

beforeEach(() => {
  vi.resetModules();
  VIEWER_IS_ADMIN = true;
  APP_ROWS = [resident("AXIS-MINE", ADMIN, ADMIN_HOUSE), resident("AXIS-KHUE", AMBIKA, SEATTLE_HOUSE)];
  getUser.mockResolvedValue({ data: { user: { id: ADMIN, email: "viewer@test.local", user_metadata: {} } }, error: null });
});

describe("GET /api/manager-applications — admin oversight is explicit", () => {
  it("an admin in their own manager portal gets only their own residents", async () => {
    expect(await ids()).toEqual(["AXIS-MINE"]);
  });

  it("an admin page that asks for oversight gets every owner's applications", async () => {
    expect(await ids("?oversight=admin")).toEqual(["AXIS-KHUE", "AXIS-MINE"]);
  });

  it("a non-admin sending the oversight parameter is still scoped to their own", async () => {
    VIEWER_IS_ADMIN = false;
    expect(await ids("?oversight=admin")).toEqual(["AXIS-MINE"]);
  });

  it("a non-admin without the parameter is unchanged", async () => {
    VIEWER_IS_ADMIN = false;
    expect(await ids()).toEqual(["AXIS-MINE"]);
  });

  it("a different oversight value is not oversight", async () => {
    expect(await ids("?oversight=all")).toEqual(["AXIS-MINE"]);
  });
});
