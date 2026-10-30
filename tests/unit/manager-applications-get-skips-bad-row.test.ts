/**
 * One inconsistent applicant row (a protected identity that also kept a plaintext copy) used to turn the
 * whole `GET /api/manager-applications` into a 500, so the manager's Applications list never loaded.
 * The bad row is skipped, logged, and reported; every other row still comes back.
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
          if (table === "profile_roles") return Promise.resolve({ data: [{ role: "manager" }], error: null }).then(resolve);
          return Promise.resolve({ data: rowsFor(), error: null }).then(resolve);
        },
      };
      return builder;
    },
  };
}

function pending(id: string, over: Record<string, unknown> = {}): Stored {
  return {
    id,
    row_data: { id, name: id, email: `${id.toLowerCase()}@example.com`, bucket: "pending", stage: "Submitted", detail: "", ...over },
    manager_user_id: OWNER,
    property_id: HOUSE,
    assigned_property_id: HOUSE,
    updated_at: "2026-07-01T00:00:00.000Z",
  };
}

beforeEach(() => {
  vi.resetModules();
  LINKS = [];
  getUser.mockResolvedValue({ data: { user: { id: OWNER, email: "o@test.local", email_confirmed_at: "confirmed", user_metadata: {} } }, error: null });
});

describe("GET /api/manager-applications with an inconsistent applicant row", () => {
  it("skips the bad row, flags it, and still returns the rest", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    APP_ROWS = [
      pending("AXIS-GOOD-1"),
      pending("AXIS-BAD", {
        _applicantIdentity: { version: 1, originOwnerId: OWNER, ciphertext: "not-real" },
        application: { fullLegalName: "Bad Row", ssn: "123-45-6789" },
      }),
      pending("AXIS-GOOD-2"),
    ];
    const { GET } = await import("@/app/api/manager-applications/route");
    const res = await GET(new Request("https://example.test/api/manager-applications"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: { id: string }[];
      skippedRowIds?: string[];
      skippedRows?: { id: string; propertyId?: string; applicationRead?: boolean }[];
    };
    expect(body.rows.map((r) => r.id).sort()).toEqual(["AXIS-GOOD-1", "AXIS-GOOD-2"]);
    expect(body.skippedRowIds).toEqual(["AXIS-BAD"]);
    expect(body.skippedRows).toEqual([{ id: "AXIS-BAD", propertyId: HOUSE, applicationRead: true }]);
    expect(JSON.stringify(body)).not.toContain("123-45-6789");
    expect(consoleError.mock.calls.some((call) => String(call[0]).includes("AXIS-BAD"))).toBe(true);
    consoleError.mockRestore();
  });

  it("reports nothing skipped when every row is consistent", async () => {
    APP_ROWS = [pending("AXIS-GOOD-1")];
    const { GET } = await import("@/app/api/manager-applications/route");
    const res = await GET(new Request("https://example.test/api/manager-applications"));
    const body = (await res.json()) as { rows: { id: string }[]; skippedRowIds?: string[] };
    expect(body.rows.map((r) => r.id)).toEqual(["AXIS-GOOD-1"]);
    expect(body.skippedRowIds).toBeUndefined();
  });
});
