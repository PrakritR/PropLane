/**
 * `GET /api/manager-applications` must not wait on the orphan-housing purge (14 sequential reads that
 * may delete): it is handed to `after()`. The response also carries `Server-Timing` phases.
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
const afterSpy = vi.fn<(run: () => unknown) => void>();
const purge = vi.fn<() => Promise<unknown>>();
let APP_ROWS: Stored[];
const OWNER = "mgr-owner";
const HOUSE = "house-1";
const LINKS: unknown[] = [];

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (run: () => unknown) => afterSpy(run),
}));
vi.mock("@/lib/auth/clear-property-housing-access", () => ({ purgeOrphanHousingRecordsForManager: () => purge() }));
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


beforeEach(() => {
  vi.resetModules();
  afterSpy.mockReset();
  purge.mockReset();
  // The sweep never finishes: a response that awaited it would hang.
  purge.mockImplementation(() => new Promise(() => {}));
  APP_ROWS = [
    {
      id: "AXIS-1",
      row_data: { id: "AXIS-1", name: "Mo", email: "mo@example.com", bucket: "approved", manuallyAdded: true, stage: "Active", detail: "" },
      manager_user_id: OWNER,
      property_id: HOUSE,
      assigned_property_id: HOUSE,
      updated_at: "2026-07-01T00:00:00.000Z",
    },
  ];
  getUser.mockResolvedValue({ data: { user: { id: OWNER, email: "o@test.local", user_metadata: {} } }, error: null });
});

async function get() {
  const { GET } = await import("@/app/api/manager-applications/route");
  return GET(new Request("https://example.test/api/manager-applications"));
}

describe("GET /api/manager-applications timing", () => {
  it("answers without awaiting the orphan purge, which is scheduled through after()", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(((await res.json()) as { rows: { id: string }[] }).rows.map((r) => r.id)).toEqual(["AXIS-1"]);
    // The purge only starts when a scheduled callback runs, after the response.
    expect(afterSpy).toHaveBeenCalled();
    expect(purge).not.toHaveBeenCalled();
    for (const [run] of afterSpy.mock.calls) void run();
    expect(purge).toHaveBeenCalledTimes(1);
  });

  it("a failing purge after the response is swallowed", async () => {
    purge.mockRejectedValue(new Error("db down"));
    await get();
    for (const [run] of afterSpy.mock.calls) await expect(Promise.resolve(run())).resolves.toBeUndefined();
    expect(purge).toHaveBeenCalledTimes(1);
  });

  it("sets a Server-Timing header with the phase durations and a total, and no ids", async () => {
    const res = await get();
    const header = res.headers.get("Server-Timing") ?? "";
    for (const phase of ["auth", "role", "links", "owned", "workspace", "rows", "normalize", "total"]) {
      expect(header).toMatch(new RegExp(`(^|, )${phase};dur=\\d+(\\.\\d+)?`));
    }
    expect(header).not.toMatch(/AXIS|mgr-owner|house-1|@/);
  });

  it("warns with the phases only when the request is slow", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await get();
    expect(warn).not.toHaveBeenCalled();
    const now = vi.spyOn(performance, "now");
    let t = 0;
    now.mockImplementation(() => (t += 2000));
    await get();
    const line = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes("manager-applications"));
    expect(line).toBeTruthy();
    const parsed = JSON.parse(line!) as { route: string; phases: Record<string, number>; rows: number };
    expect(parsed.route).toBe("manager-applications");
    expect(parsed.rows).toBe(1);
    expect(parsed.phases.total).toBeGreaterThan(3000);
    now.mockRestore();
    warn.mockRestore();
  });
});
