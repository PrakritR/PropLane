/**
 * `/api/portal-lease-pipeline` is the data route behind the resident Lease
 * panel — the section this branch exists to unlock. Reading the actor role off
 * the legacy `profiles.role`, a manager+resident fell past the resident-scoped
 * `.or(resident_user_id / resident_email)` query into the manager branch, so
 * the resident portal pulled the manager's whole pipeline AND, when that
 * account rents from a DIFFERENT manager, their own lease was not in the
 * response at all — the captain's "the lease arrives and the resident cannot
 * open it" symptom, one layer below the nav fix.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const USER_ID = "user-both";
const RESIDENT_EMAIL = "both@example.com";

const getUser = vi.fn();
const isAdminUser = vi.fn(async () => false);
const fetchLeasesForManagerUser = vi.fn(async () => MANAGER_PIPELINE);

let PROFILE: { email: string; role: string | null } | null = null;
let PROFILE_ROLES: string[] = [];
let PORTAL_ROLES: string[] = [];
let EFFECTIVE_ROLE: string | null = null;

/** Their own lease, on a property managed by SOMEONE ELSE. */
const OWN_LEASE = {
  id: "lease-mine",
  resident_user_id: USER_ID,
  resident_email: RESIDENT_EMAIL,
  manager_user_id: "some-other-manager",
  row_data: { id: "lease-mine", residentEmail: RESIDENT_EMAIL },
  updated_at: "2026-03-01T00:00:00Z",
};
/** A lease in the portfolio this same account MANAGES — never theirs to read as a resident. */
const OWN_PORTFOLIO_LEASE = {
  id: "lease-portfolio",
  resident_user_id: "tenant-user",
  resident_email: "tenant@example.com",
  manager_user_id: USER_ID,
  row_data: { id: "lease-portfolio", residentEmail: "tenant@example.com" },
  updated_at: "2026-02-01T00:00:00Z",
};
const STRANGER_LEASE = {
  id: "lease-stranger",
  resident_user_id: "stranger-user",
  resident_email: "stranger@example.com",
  manager_user_id: "some-other-manager",
  row_data: { id: "lease-stranger", residentEmail: "stranger@example.com" },
  updated_at: "2026-01-01T00:00:00Z",
};

const ALL_LEASES = [OWN_LEASE, OWN_PORTFOLIO_LEASE, STRANGER_LEASE];
const MANAGER_PIPELINE = [OWN_PORTFOLIO_LEASE];

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => makeDb() }));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: (...a: unknown[]) => isAdminUser(...(a as [])) }));
vi.mock("@/lib/auth/portal-access", () => ({
  ACTIVE_PORTAL_COOKIE: "axis_active_portal",
  getPortalAccessContext: async () => ({
    user: null,
    profile: null,
    roles: PORTAL_ROLES,
    effectiveRole: EFFECTIVE_ROLE,
  }),
}));
vi.mock("@/lib/auth/manager-lease-scope", () => ({
  fetchLeasesForManagerUser: (...a: unknown[]) => fetchLeasesForManagerUser(...(a as [])),
  managerCanAccessLeaseRecord: async () => true,
}));
vi.mock("@/lib/documents/document-auto-file-hooks.server", () => ({
  autoFileLeaseDocument: async () => undefined,
}));

/** Chainable Supabase stub that applies the route's `.or()` resident scope. */
function makeDb() {
  return {
    from(table: string) {
      let orFilter = "";
      const rowsFor = () => {
        if (table !== "portal_lease_pipeline_records") return [];
        if (!orFilter) return ALL_LEASES;
        const clauses = orFilter.split(",").map((clause) => clause.split("."));
        return ALL_LEASES.filter((lease) =>
          clauses.some(([column, , value]) => {
            if (column === "resident_user_id") return lease.resident_user_id === value;
            if (column === "resident_email") return lease.resident_email === value;
            return false;
          }),
        );
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        order: () => builder,
        limit: () => Promise.resolve({ data: rowsFor(), error: null }),
        or: (filter: string) => {
          orFilter = filter;
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
      };
      return builder;
    },
  };
}

async function loadLeases(): Promise<{ status: number; ids: string[] }> {
  const { GET } = await import("@/app/api/portal-lease-pipeline/route");
  const res = await GET();
  if (res.status !== 200) return { status: res.status, ids: [] };
  const body = (await res.json()) as { rows: Array<{ id: string }> };
  return { status: res.status, ids: body.rows.map((row) => row.id) };
}

beforeEach(() => {
  vi.clearAllMocks();
  isAdminUser.mockResolvedValue(false);
  fetchLeasesForManagerUser.mockResolvedValue(MANAGER_PIPELINE);
  getUser.mockResolvedValue({ data: { user: { id: USER_ID, email: RESIDENT_EMAIL } }, error: null });
});

describe("portal-lease-pipeline — manager-only account", () => {
  beforeEach(() => {
    PROFILE = { email: "manager@example.com", role: "manager" };
    PROFILE_ROLES = ["manager"];
    PORTAL_ROLES = ["manager"];
    EFFECTIVE_ROLE = "manager";
  });

  it("still receives its full manager pipeline", async () => {
    const { status, ids } = await loadLeases();
    expect(status).toBe(200);
    expect(fetchLeasesForManagerUser).toHaveBeenCalled();
    expect(ids).toEqual([OWN_PORTFOLIO_LEASE.id]);
  });
});

describe("portal-lease-pipeline — manager+resident acting in the resident portal", () => {
  beforeEach(() => {
    PROFILE = { email: RESIDENT_EMAIL, role: "manager" };
    PROFILE_ROLES = ["manager", "resident"];
    PORTAL_ROLES = ["manager", "resident"];
    EFFECTIVE_ROLE = "resident";
  });

  it("takes the resident branch instead of the manager pipeline", async () => {
    const { status } = await loadLeases();
    expect(status).toBe(200);
    expect(fetchLeasesForManagerUser).not.toHaveBeenCalled();
  });

  it("returns their OWN lease even though a different manager owns that property", async () => {
    const { ids } = await loadLeases();
    expect(ids).toContain(OWN_LEASE.id);
  });

  it("omits leases from the portfolio they manage, and every stranger's lease", async () => {
    const { ids } = await loadLeases();
    expect(ids).not.toContain(OWN_PORTFOLIO_LEASE.id);
    expect(ids).not.toContain(STRANGER_LEASE.id);
    expect(ids).toEqual([OWN_LEASE.id]);
  });
});

describe("portal-lease-pipeline — manager+resident acting in the manager portal", () => {
  beforeEach(() => {
    PROFILE = { email: RESIDENT_EMAIL, role: "manager" };
    PROFILE_ROLES = ["manager", "resident"];
    PORTAL_ROLES = ["manager", "resident"];
    EFFECTIVE_ROLE = "manager";
  });

  it("keeps the manager pipeline", async () => {
    const { ids } = await loadLeases();
    expect(fetchLeasesForManagerUser).toHaveBeenCalled();
    expect(ids).toEqual([OWN_PORTFOLIO_LEASE.id]);
  });
});

describe("portal-lease-pipeline — admin", () => {
  beforeEach(() => {
    PROFILE = { email: "admin@example.com", role: "admin" };
    PROFILE_ROLES = [];
    PORTAL_ROLES = ["admin"];
    EFFECTIVE_ROLE = "admin";
    isAdminUser.mockResolvedValue(true);
  });

  it("still reads every lease, unscoped", async () => {
    const { status, ids } = await loadLeases();
    expect(status).toBe(200);
    expect(fetchLeasesForManagerUser).not.toHaveBeenCalled();
    expect(ids).toEqual(ALL_LEASES.map((lease) => lease.id));
  });
});

describe("portal-lease-pipeline — unauthenticated", () => {
  beforeEach(() => {
    PROFILE = null;
    PROFILE_ROLES = [];
    PORTAL_ROLES = [];
    EFFECTIVE_ROLE = null;
    getUser.mockResolvedValue({ data: { user: null }, error: null });
  });

  it("still answers 401", async () => {
    expect((await loadLeases()).status).toBe(401);
  });
});
