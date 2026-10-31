/**
 * The dual-audience portal routes (`/api/portal-work-orders`,
 * `/api/portal-service-requests`) branch on the actor role in BOTH directions:
 * `!== "resident"` selects the manager's portfolio-wide read, `=== "resident"`
 * applies the `resident_email` scope. Read off the legacy `profiles.role`, a
 * manager+resident took the manager branch in the RESIDENT portal, so the
 * Add-on services tab rendered the manager's own rows as the resident's.
 *
 * Both branches now read one value from `resolveResidentScopedActorRole`, so
 * the resident portal is email-scoped and the manager portal is unchanged.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const USER_ID = "user-both";
const RESIDENT_EMAIL = "both@example.com";

const getUser = vi.fn();
const isAdminUser = vi.fn(async () => false);
const fetchRowsForManagerWithLinked = vi.fn(async () => MANAGER_RECORDS);

let PROFILE: { email: string; role: string | null } | null = null;
let PROFILE_ROLES: string[] = [];
let PORTAL_ROLES: string[] = [];
let EFFECTIVE_ROLE: string | null = null;
let PORTAL_CONTEXT_THROWS = false;

const RESIDENT_ROW = { residentUserId: USER_ID, id: "wo-mine", title: "My leaky sink", residentEmail: RESIDENT_EMAIL };
const OTHER_RESIDENT_ROW = { residentUserId: "other-user", id: "wo-theirs", title: "Someone else's sink", residentEmail: "tenant@example.com" };
const MANAGER_ONLY_ROW = { id: "wo-portfolio", title: "Portfolio roof", residentEmail: "tenant@example.com" };

const ALL_RECORDS = [
  { id: RESIDENT_ROW.id, resident_user_id: USER_ID, resident_email: RESIDENT_EMAIL, row_data: RESIDENT_ROW, updated_at: "2026-02-01T00:00:00Z" },
  {
    id: OTHER_RESIDENT_ROW.id,
    resident_user_id: "other-user",
    resident_email: "tenant@example.com",
    row_data: OTHER_RESIDENT_ROW,
    updated_at: "2026-01-01T00:00:00Z",
  },
];
const MANAGER_RECORDS = [
  { id: MANAGER_ONLY_ROW.id, row_data: MANAGER_ONLY_ROW, updated_at: "2026-03-01T00:00:00Z" },
];

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => makeDb() }));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: (...a: unknown[]) => isAdminUser(...(a as [])) }));
vi.mock("@/lib/auth/portal-access", () => ({
  ACTIVE_PORTAL_COOKIE: "axis_active_portal",
  getPortalAccessContext: async () => {
    if (PORTAL_CONTEXT_THROWS) throw new Error("profile_roles read failed");
    return { user: { id: USER_ID }, profile: null, roles: PORTAL_ROLES, effectiveRole: EFFECTIVE_ROLE };
  },
}));
vi.mock("@/lib/auth/co-manager-module-scope", () => ({
  fetchRowsForManagerWithLinked: (...a: unknown[]) => fetchRowsForManagerWithLinked(...(a as [])),
  linkedPropertyIdsForModule: async () => new Set<string>(),
  // Not under test here: an unresolved (never-narrowing) active workspace,
  // same as accounts with no workspace at all.
  resolveManagerWorkspaceRowScope: async () => ({ propertyIds: null, untaggedOwnedVisible: true }),
  rowInWorkspaceScope: () => true,
}));
vi.mock("@/lib/repair-service-request-scopes.server", () => ({
  repairServiceRequestScopesForManager: async () => undefined,
  repairWorkOrderScopesForManager: async () => undefined,
  shouldRunScopeRepair: () => false,
}));
vi.mock("@/lib/resident-manager-scope", () => ({ resolveResidentFilingScope: async () => null }));
vi.mock("@/lib/work-order-notification.server", () => ({
  notifyManagerOfResidentFiledItem: async () => undefined,
  notifyWorkOrderEvent: async () => undefined,
}));
vi.mock("@/lib/work-order-dispatch.server", () => ({ prepareDispatch: async () => undefined }));
vi.mock("@/lib/google-calendar/sync.server", () => ({
  syncWorkOrderToGoogleCalendar: async (_d: unknown, _m: unknown, row: unknown) => row,
  workOrderGoogleCalendarSyncChanged: () => false,
}));

/** Chainable Supabase stub that actually applies the `.eq()` filters. */
function makeDb() {
  return {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const rowsFor = () => {
        if (table === "portal_work_order_records" || table === "portal_service_request_records") {
          return ALL_RECORDS.filter((row) =>
            filters.every(([col, val]) => col === "resident_email" ? row.resident_email === val : col === "resident_user_id" ? row.resident_user_id === val : true),
          );
        }
        if (table === "profile_roles") return PROFILE_ROLES.map(role => ({ role }));
        return [];
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        order: () => builder,
        limit: () => builder,
        is: () => builder,
        in: () => builder,
        eq: (col: string, val: unknown) => {
          filters.push([col, val]);
          return builder;
        },
        maybeSingle() {
          if (table === "profiles") return Promise.resolve({ data: PROFILE, error: null });
          if (table === "profile_roles") {
            return Promise.resolve({
              data: PROFILE_ROLES.includes("resident") ? { role: "resident" } : null,
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        },
        then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
          return Promise.resolve({ data: rowsFor(), error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}

async function loadWorkOrders() {
  const { GET } = await import("@/app/api/portal-work-orders/route");
  return GET();
}

async function loadServiceRequests() {
  const { GET } = await import("@/app/api/portal-service-requests/route");
  return GET();
}

type Loader = () => Promise<Response>;

const SURFACES: Array<{ name: string; load: Loader }> = [
  { name: "portal-work-orders", load: loadWorkOrders },
  { name: "portal-service-requests", load: loadServiceRequests },
];

beforeEach(() => {
  vi.clearAllMocks();
  PORTAL_CONTEXT_THROWS = false;
  isAdminUser.mockResolvedValue(false);
  fetchRowsForManagerWithLinked.mockResolvedValue(MANAGER_RECORDS);
  getUser.mockResolvedValue({ data: { user: { id: USER_ID, email: RESIDENT_EMAIL } }, error: null });
});

for (const surface of SURFACES) {
  describe(`${surface.name} — manager+resident acting in the resident portal`, () => {
    beforeEach(() => {
      PROFILE = { email: RESIDENT_EMAIL, role: "manager" };
      PROFILE_ROLES = ["manager", "resident"];
      PORTAL_ROLES = ["manager", "resident"];
      EFFECTIVE_ROLE = "resident";
    });

    it("returns only the resident's own rows, never the portfolio they manage", async () => {
      const res = await surface.load();
      expect(res.status).toBe(200);
      const ids = ((await res.json()).rows as Array<{ id: string }>).map((row) => row.id);
      expect(ids).toEqual([RESIDENT_ROW.id]);
      expect(ids).not.toContain(MANAGER_ONLY_ROW.id);
      expect(ids).not.toContain(OTHER_RESIDENT_ROW.id);
      expect(fetchRowsForManagerWithLinked).not.toHaveBeenCalled();
    });
  });

  describe(`${surface.name} — manager+resident acting in the manager portal`, () => {
    beforeEach(() => {
      PROFILE = { email: RESIDENT_EMAIL, role: "manager" };
      PROFILE_ROLES = ["manager", "resident"];
      PORTAL_ROLES = ["manager", "resident"];
      EFFECTIVE_ROLE = "manager";
    });

    it("still gets the portfolio-wide manager read", async () => {
      const res = await surface.load();
      expect(res.status).toBe(200);
      const ids = ((await res.json()).rows as Array<{ id: string }>).map((row) => row.id);
      expect(ids).toContain(MANAGER_ONLY_ROW.id);
      expect(fetchRowsForManagerWithLinked).toHaveBeenCalled();
    });
  });

  /**
   * The CAPABILITY is the stored `profile_roles` row; the active portal only says which of two
   * capabilities a request is exercising. An admin+manager in the admin portal reads as the manager
   * it stores, scoped to its own id as always — that case used to be denied outright: a 403 on work
   * orders, services and the lease pipeline outside `?oversight=admin`, against `AGENTS.md`
   * § "Admin borrows" ("a platform admin reads and writes as the manager they are").
   *
   * Widening is a decision that needs evidence, though, and the ACTIVE PORTAL has to supply it. A
   * context that cannot be trusted — the read threw, or its own role list disagrees with the stored
   * roles — and one that names no portal at all (`getPortalAccessContext` reports a null
   * `effectiveRole` for every multi-role account with no valid `axis_active_portal` cookie) both
   * narrow to resident: absence of an answer must never buy the broader scope. The groups below pin
   * each half.
   */
  describe(`${surface.name} — portal context degraded to the legacy role`, () => {
    beforeEach(() => {
      // getPortalAccessContext falls back to `profiles.role` when its own
      // profile_roles read errors, so it reports manager-only with no throw —
      // a context that contradicts the stored roles rather than confirming them.
      PROFILE = { email: RESIDENT_EMAIL, role: "manager" };
      PROFILE_ROLES = ["manager", "resident"];
      PORTAL_ROLES = ["manager"];
      EFFECTIVE_ROLE = "manager";
    });

    it("narrows to the resident scope rather than widening on a contradictory context", async () => {
      const res = await surface.load();
      expect(res.status).toBe(200);
      const ids = ((await res.json()).rows as Array<{ id: string }>).map((row) => row.id);
      expect(ids).toEqual([RESIDENT_ROW.id]);
      expect(fetchRowsForManagerWithLinked).not.toHaveBeenCalled();
    });
  });

  describe(`${surface.name} — active portal unresolved`, () => {
    beforeEach(() => {
      // getPortalAccessContext returns effectiveRole: null for any multi-role
      // account whenever axis_active_portal is absent or names a role they do
      // not hold, and raises no error.
      PROFILE = { email: RESIDENT_EMAIL, role: "manager" };
      PROFILE_ROLES = ["manager", "resident"];
      PORTAL_ROLES = ["manager", "resident"];
      EFFECTIVE_ROLE = null;
    });

    it("narrows to the resident scope rather than widening on a missing answer", async () => {
      const res = await surface.load();
      expect(res.status).toBe(200);
      const ids = ((await res.json()).rows as Array<{ id: string }>).map((row) => row.id);
      expect(ids).toEqual([RESIDENT_ROW.id]);
      expect(fetchRowsForManagerWithLinked).not.toHaveBeenCalled();
    });
  });

  describe(`${surface.name} — portal context read throws`, () => {
    beforeEach(() => {
      PROFILE = { email: RESIDENT_EMAIL, role: "manager" };
      PROFILE_ROLES = ["manager", "resident"];
      PORTAL_ROLES = ["manager", "resident"];
      EFFECTIVE_ROLE = "manager";
      PORTAL_CONTEXT_THROWS = true;
    });

    it("narrows to the resident scope rather than propagating the error or widening", async () => {
      // The same catch also swallows the phone-gate `redirect()` getPortalAccessContext throws, so
      // widening here would hand a phone-gated account the whole portfolio.
      const res = await surface.load();
      expect(res.status).toBe(200);
      const ids = ((await res.json()).rows as Array<{ id: string }>).map((row) => row.id);
      expect(ids).toEqual([RESIDENT_ROW.id]);
      expect(fetchRowsForManagerWithLinked).not.toHaveBeenCalled();
    });
  });

  describe(`${surface.name} — a resident-only account with a stale manager cookie`, () => {
    beforeEach(() => {
      // The narrowing that still has to hold: the cookie cannot widen a capability the account
      // does not store, so this stays on the resident's own rows.
      PROFILE = { email: RESIDENT_EMAIL, role: "manager" };
      PROFILE_ROLES = ["resident"];
      PORTAL_ROLES = ["resident"];
      EFFECTIVE_ROLE = "manager";
    });

    it("returns only the resident's own rows", async () => {
      const res = await surface.load();
      expect(res.status).toBe(200);
      const ids = ((await res.json()).rows as Array<{ id: string }>).map((row) => row.id);
      expect(ids).toEqual([RESIDENT_ROW.id]);
      expect(fetchRowsForManagerWithLinked).not.toHaveBeenCalled();
    });
  });

  describe(`${surface.name} — legacy resident with no profile_roles row`, () => {
    beforeEach(() => {
      PROFILE = { email: RESIDENT_EMAIL, role: "resident" };
      PROFILE_ROLES = [];
      PORTAL_ROLES = ["resident"];
      EFFECTIVE_ROLE = null;
    });

    it("denies access without a stored role", async () => {
      const res = await surface.load();
      expect(res.status).toBe(403);
      expect(fetchRowsForManagerWithLinked).not.toHaveBeenCalled();
    });
  });

  describe(`${surface.name} — manager holding no resident role`, () => {
    beforeEach(() => {
      PROFILE = { email: "manager@example.com", role: "manager" };
      PROFILE_ROLES = ["manager"];
      PORTAL_ROLES = ["manager"];
      EFFECTIVE_ROLE = "manager";
    });

    it("keeps the manager branch", async () => {
      const res = await surface.load();
      expect(res.status).toBe(200);
      const ids = ((await res.json()).rows as Array<{ id: string }>).map((row) => row.id);
      expect(ids).toContain(MANAGER_ONLY_ROW.id);
      expect(fetchRowsForManagerWithLinked).toHaveBeenCalled();
    });
  });

  describe(`${surface.name} — unauthenticated`, () => {
    beforeEach(() => {
      PROFILE = null;
      PROFILE_ROLES = [];
      PORTAL_ROLES = ["resident"];
      EFFECTIVE_ROLE = null;
      getUser.mockResolvedValue({ data: { user: null }, error: null });
    });

    it("still answers 401", async () => {
      expect((await surface.load()).status).toBe(401);
    });
  });
}
