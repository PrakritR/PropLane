/**
 * `GET /api/manager-applications` feeds the Residents list and the Bookings grid. A resident slot
 * (approved / manually added) some other manager filed naming the viewer's house must not reach them:
 * a slot belongs to a house only when its author is the owner or a teammate linked to it.
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
let LINKS: unknown[];
const OWNER = "mgr-owner";
const TEAMMATE = "mgr-teammate";
const STRANGER = "mgr-stranger";
const HOUSE = "house-victim";

vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: vi.fn(async () => false) }));
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
          const all = [{ id: HOUSE, manager_user_id: OWNER }];
          return f.eqCol === "manager_user_id" ? all.filter((p) => p.manager_user_id === f.eqVal) : all;
        }
        if (table === "account_link_invites") return LINKS;
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
        maybeSingle: () => Promise.resolve({ data: table === "profiles" ? { role: "manager", email: "o@test.local" } : null, error: null }),
        then(resolve: (v: { data: unknown; error: unknown }) => unknown) {
          return Promise.resolve({ data: rowsFor(), error: null }).then(resolve);
        },
      };
      return builder;
    },
  };
}

function slot(id: string, author: string | null, over: Partial<Stored> = {}): Stored {
  return {
    id,
    row_data: { id, name: id, email: `${id.toLowerCase()}@example.com`, bucket: "approved", manuallyAdded: true, stage: "Active", detail: "" },
    manager_user_id: author,
    // The plant: filed under the stranger's own house, pointing at the victim's.
    property_id: author === STRANGER ? "house-stranger" : HOUSE,
    assigned_property_id: HOUSE,
    updated_at: "2026-07-01T00:00:00.000Z",
    ...over,
  };
}

async function ids() {
  const { GET } = await import("@/app/api/manager-applications/route");
  const res = await GET(new Request("https://example.test/api/manager-applications"));
  expect(res.status).toBe(200);
  return ((await res.json()) as { rows: { id: string }[] }).rows.map((r) => r.id).sort();
}

beforeEach(() => {
  vi.resetModules();
  LINKS = [{ inviter_user_id: OWNER, invitee_user_id: TEAMMATE, assigned_property_ids: [HOUSE], team_role: "leasing" }];
  getUser.mockResolvedValue({ data: { user: { id: OWNER, email: "o@test.local", user_metadata: {} } }, error: null });
});

describe("GET /api/manager-applications resident slots", () => {
  it("drops a slot a stranger filed naming the viewer's house, keeps the owner's and a linked teammate's", async () => {
    APP_ROWS = [slot("AXIS-PLANT", STRANGER), slot("AXIS-OWNER", OWNER), slot("AXIS-TEAM", TEAMMATE)];
    expect(await ids()).toEqual(["AXIS-OWNER", "AXIS-TEAM"]);
  });

  it("keeps an unstamped legacy slot and an application in flight", async () => {
    APP_ROWS = [
      slot("AXIS-LEGACY", null),
      slot("AXIS-PENDING", STRANGER, { row_data: { id: "AXIS-PENDING", name: "p", email: "p@example.com", bucket: "pending", stage: "Submitted", detail: "" } }),
    ];
    expect(await ids()).toEqual(["AXIS-LEGACY", "AXIS-PENDING"]);
  });
});
