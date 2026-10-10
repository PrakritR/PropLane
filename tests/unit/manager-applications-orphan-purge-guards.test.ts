/**
 * `GET /api/manager-applications` schedules an orphan-housing sweep that can delete rows. It is a
 * write inside a GET, so:
 *   - a View-as session (read-only) never schedules it;
 *   - a failed co-manager lookup is not "no co-managed houses": the sweep deletes nothing;
 *   - the live property set is read inside the sweep (an owned property created after the
 *     response still counts as live).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const getUser = vi.fn();
const afterCallbacks: Array<() => unknown> = [];
let VIEW_AS_OPEN = false;
let OWNED: { id: string; manager_user_id: string }[] = [];
let LINK_LOOKUP_FAILS = false;
const purge = vi.fn<(...args: unknown[]) => Promise<{ applicationsCleared: number; recordsDeleted: number }>>(async () => ({
  applicationsCleared: 0,
  recordsDeleted: 0,
}));
const linkedIds = vi.fn(async (_db: unknown, _uid: string, _module: string, options?: { strict?: boolean }) => {
  if (LINK_LOOKUP_FAILS && options?.strict) throw new Error("Co-manager link permissions lookup failed: boom");
  return new Set<string>(["co-managed-house"]);
});

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (fn: () => unknown) => {
    afterCallbacks.push(fn);
  },
}));
vi.mock("@/lib/auth/view-as.server", () => ({ isViewAsSessionOpen: vi.fn(async () => VIEW_AS_OPEN) }));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: vi.fn(async () => false) }));
vi.mock("@/lib/auth/co-manager-module-scope", () => ({
  linkedPropertyIdsForModule: (...args: Parameters<typeof linkedIds>) => linkedIds(...args),
}));
vi.mock("@/lib/auth/clear-property-housing-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/clear-property-housing-access")>()),
  purgeOrphanHousingRecordsForManager: (...args: unknown[]) => purge(...args),
}));
vi.mock("@/lib/auth/provision-approved-resident", () => ({
  provisionApprovedResidentAccount: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/workspaces/scope.server", () => ({ activeWorkspacePropertyScope: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => makeDb() }));

function makeDb() {
  return {
    from(table: string) {
      let eqVal: string | null = null;
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq(_column: string, value: string) {
          eqVal = value;
          return builder;
        },
        in: () => builder,
        is: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: () =>
          Promise.resolve({ data: table === "profiles" ? { role: "manager", email: "owner@test.proplane.local" } : null, error: null }),
        then(resolve: (v: { data: unknown; error: unknown }) => unknown) {
          const data = table === "manager_property_records" ? OWNED.filter((p) => p.manager_user_id === eqVal) : [];
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return builder;
    },
  };
}

const MANAGER = "mgr-purge";

async function get() {
  const { GET } = await import("@/app/api/manager-applications/route");
  return GET(new Request("https://example.test/api/manager-applications"));
}

async function drainAfter() {
  while (afterCallbacks.length) await afterCallbacks.shift()!();
}

beforeEach(() => {
  vi.clearAllMocks();
  afterCallbacks.length = 0;
  VIEW_AS_OPEN = false;
  LINK_LOOKUP_FAILS = false;
  OWNED = [{ id: "owned-house", manager_user_id: MANAGER }];
  getUser.mockResolvedValue({
    data: { user: { id: MANAGER, email: "owner@test.proplane.local", user_metadata: {} } },
    error: null,
  });
});

describe("GET /api/manager-applications orphan purge", () => {
  it("sweeps with the owned + co-managed houses on a normal read", async () => {
    expect((await get()).status).toBe(200);
    await drainAfter();
    expect(purge).toHaveBeenCalledTimes(1);
    expect([...(purge.mock.calls[0]![2] as Set<string>)].sort()).toEqual(["co-managed-house", "owned-house"]);
  });

  it("never schedules the sweep during a View-as session", async () => {
    VIEW_AS_OPEN = true;
    expect((await get()).status).toBe(200);
    await drainAfter();
    expect(afterCallbacks).toHaveLength(0);
    expect(purge).not.toHaveBeenCalled();
  });

  it("skips the sweep when the strict co-manager lookup fails, instead of deleting co-managed rows", async () => {
    LINK_LOOKUP_FAILS = true;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await get()).status).toBe(200);
    await drainAfter();
    expect(purge).not.toHaveBeenCalled();
    expect(linkedIds.mock.calls.some((call) => call[3]?.strict === true)).toBe(true);
    errorSpy.mockRestore();
  });

  it("re-reads owned properties inside the sweep, so a house created after the response stays live", async () => {
    expect((await get()).status).toBe(200);
    OWNED = [...OWNED, { id: "created-after-response", manager_user_id: MANAGER }];
    await drainAfter();
    expect((purge.mock.calls[0]![2] as Set<string>).has("created-after-response")).toBe(true);
  });
});
